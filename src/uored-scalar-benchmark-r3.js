import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { ROOT } from './evidence.js';
import { readFiniteAcceleration } from './uored-finite-domain.js';
import { PREFIX_SAMPLES, RAW_START, RAW_WINDOW, prefixNoiseRms } from './uored-commissioning.js';
import { extract } from './uored-structure-dsp.js';
import { extractScalar } from './uored-scalar-kernel-r3.js';
import { config, commission, decide, referenceHash } from './uored-structure-core.js';
import { percentile } from './detector.js';

const protocolPath = 'research/uored-scalar-benchmark-protocol-2026-10-26.json';
const newProtocolPath = 'research/uored-scalar-benchmark-protocol-r3-2026-10-26.json';
const planPath = 'datasets/uored-paired-pilot-2026-10-25.json';
const parityPath = 'results/uored-scalar-kernel-parity-r3-2026-10-26.json';
const freezePath = 'research/uored-scalar-benchmark-freeze-r3-2026-10-26.json';
const resultPath = 'results/uored-scalar-benchmark-r3-2026-10-26.json';
const code = ['src/uored-scalar-benchmark-r3.js', 'src/uored-scalar-kernel-r3.js',
  'src/uored-structure-dsp.js', 'src/uored-structure-core.js',
  'src/uored-finite-domain.js', 'src/uored-commissioning.js',
  'src/uored-envelope-dsp.js', 'src/data.js', 'src/detector.js'];
const file = (path) => join(ROOT, path);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (path) => sha(readFileSync(file(path)));
const load = (path) => JSON.parse(readFileSync(file(path), 'utf8'));
const protocol = load(newProtocolPath), plan = load(planPath);
const original = load(protocolPath), parity = load(parityPath);
const originalSignature = JSON.stringify(
  [original.files, original.order, original.warmup, original.repetitions, original.chunkSize]);
const newSignature = JSON.stringify(
  [protocol.files, protocol.order, protocol.warmup, protocol.repetitions, protocol.chunkSize]);
if (originalSignature !== newSignature ||
    protocol.id !== 'uored-scalar-host-benchmark-r3-v1' ||
    protocol.v1ProtocolSha256 !== hash(protocolPath) ||
    protocol.paritySha256 !== hash(parityPath) || !parity.exact ||
    protocol.planSha256 !== hash(planPath)) {
  throw new Error('r3 benchmark must keep original fixed host protocol and new parity.');
}
const meta = new Map(plan.records.map((item) => [item.name, item]));
const allowed = [...protocol.files, 'H_3_0.mat', 'H_8_0.mat'];
function decode(name) {
  if (!allowed.includes(name) || parity.inputSha256ByName[name] !== meta.get(name)?.sha256) {
    throw new Error('Only approved development inputs allowed.');
  }
  const info = meta.get(name), path = join(plan.destinationDirectory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== info.bytes) {
    throw new Error('Publisher file size/type mismatch.');
  }
  const bytes = readFileSync(path);
  if (sha(bytes) !== info.sha256) throw new Error('Publisher SHA mismatch.');
  const data = readFiniteAcceleration(bytes);
  if (data.variable !== name.slice(0, -4) || data.samples.length !== 420000) {
    throw new Error('Publisher MAT identity/count mismatch.');
  }
  return data.samples;
}
function freeze() {
  if (existsSync(file(freezePath)) || existsSync(file(resultPath))) {
    throw new Error('r3 benchmark already frozen or scored.');
  }
  const body = {
    id: protocol.id, frozenAtUtc: new Date().toISOString(),
    protocolSha256: hash(newProtocolPath), paritySha256: hash(parityPath),
    sourceHashes: Object.fromEntries(code.map((p) => [p, hash(p)])),
    inputHashes: Object.fromEntries(allowed.map((name) => [name, meta.get(name).sha256])),
    scope: 'Same four development recordings, sequence, warmup, 3 repetitions, flags and boundaries as v1; new lifecycle API only.',
  };
  writeFileSync(file(freezePath), `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
  console.log(`R3_BENCHMARK_FROZEN ${hash(freezePath)}`);
}
function locked() {
  const freeze = load(freezePath);
  if (freeze.protocolSha256 !== hash(newProtocolPath) ||
      freeze.paritySha256 !== hash(parityPath)) throw new Error('r3 benchmark lock changed.');
  for (const p of code) if (freeze.sourceHashes[p] !== hash(p)) {
    throw new Error(`Pinned r3 source changed: ${p}`);
  }
  for (const name of allowed) if (freeze.inputHashes[name] !== meta.get(name).sha256) {
    throw new Error('Pinned development source changed.');
  }
}
function child(method, name) {
  locked();
  const unit = Number(name.split('_')[1]), refName = `H_${unit}_0.mat`;
  const ioStart = performance.now(), raw = decode(name);
  const ioMs = performance.now() - ioStart;
  const refIoStart = performance.now(), healthy = name === refName ? raw : decode(refName);
  const referenceIoMs = performance.now() - refIoStart;
  const prefix = healthy.subarray(0, PREFIX_SAMPLES), fn = method === 'generic' ?
    extract : extractScalar, amount = prefixNoiseRms(prefix);
  const features = (opts) => {
    const output = fn(prefix, { count: 32, ...opts });
    return method === 'generic' ? output.features['matched-scalar'] : output.features;
  };
  const commissionStart = performance.now();
  const reference = commission({ healthConfirmed: true,
    methodId: 'matched-scalar', installationConfig: config(unit, 1),
    clean: features({}), white: features({ noiseRms: amount,
      recording: refName, phase: 'commission' }),
    colored: features({ noiseRms: amount, recording: refName,
      phase: 'commission-colored' }) });
  const commissionMs = performance.now() - commissionStart;
  const query = raw.subarray(0, RAW_START + 77 * RAW_WINDOW), runs = [];
  for (let i = -protocol.warmup; i < protocol.repetitions; i++) {
    const started = performance.now();
    const extracted = fn(query, { count: 77, chunkSize: protocol.chunkSize });
    const rawToFeatureMs = performance.now() - started;
    const frameFeatures = method === 'generic' ?
      extracted.features['matched-scalar'] : extracted.features;
    const decisionStart = performance.now();
    const answers = frameFeatures.slice(name.startsWith('H_') ? 32 : 0)
      .map((feature) => decide(reference, { feature, installationConfig: reference.config }));
    const decisionsMs = performance.now() - decisionStart;
    if (i >= 0) runs.push({
      rawToFeatureMs, stressMs: extracted.stressMs,
      dspAndFeatureMs: method === 'generic' ?
        extracted.filterMs + extracted.featureMs : extracted.scalarMs,
      decisionsMs, rawToAllDecisionsMs: rawToFeatureMs + decisionsMs,
      outputs: answers.length, decisionDigest: sha(Buffer.from(JSON.stringify(answers))),
    });
  }
  const maxRssBytes = process.resourceUsage().maxRSS * 1024;
  if (!Number.isSafeInteger(maxRssBytes) || maxRssBytes <= 0) {
    throw new Error('OS peak RSS unavailable; no snapshot fallback.');
  }
  return { name, method, ioMs, referenceIoMs, commissionMs,
    referenceSha256: referenceHash(reference), runs, maxRssBytes };
}
function run() {
  locked();
  if (existsSync(file(resultPath))) throw new Error('r3 benchmark exists; no overwrite.');
  const sequence = protocol.order.map((method, i) =>
    ({ method, name: protocol.files[Math.floor(i / 2)] })), rows = [];
  for (const { method, name } of sequence) {
    const done = spawnSync(process.execPath, ['--single-threaded', '--v8-pool-size=1',
      file('src/uored-scalar-benchmark-r3.js'), 'child', method, name],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (done.status !== 0) throw new Error(`r3 child ${name}/${method}: ${done.stderr}`);
    rows.push(JSON.parse(done.stdout.trim()));
  }
  const summaries = protocol.files.map((name) => {
    const a = rows.find((r) => r.name === name && r.method === 'generic');
    const b = rows.find((r) => r.name === name && r.method === 'scalar');
    if (a.referenceSha256 !== b.referenceSha256 || a.runs.some((r, i) =>
      r.decisionDigest !== b.runs[i].decisionDigest || r.outputs !== b.runs[i].outputs)) {
      throw new Error(`r3 timed decisions/reference differ: ${name}`);
    }
    const ms = (row) => row.runs.map((r) => r.rawToAllDecisionsMs);
    return { name, genericMedianMs: percentile(ms(a), .5),
      scalarMedianMs: percentile(ms(b), .5),
      genericP95Ms: percentile(ms(a), .95),
      scalarP95Ms: percentile(ms(b), .95),
      genericPeakRssBytes: a.maxRssBytes, scalarPeakRssBytes: b.maxRssBytes };
  });
  const body = {
    id: protocol.id, scope: 'Development host implementation-only study; no consumed target rerun or quality inference.',
    freezeSha256: hash(freezePath), protocolSha256: hash(newProtocolPath),
    host: { node: process.version, platform: process.platform, arch: process.arch,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
      flags: ['--single-threaded', '--v8-pool-size=1'] },
    measurement: 'Same v1 four files/alternating eight-child order: one untimed warmup, three timed repeats; SHA + MAT decode separately timed, prefix commission separately timed, stress/DSP/decisions reported; raw-to-all-decisions excludes MAT I/O/acquisition/UI. Node resourceUsage maxRSS KiB ×1024 is whole-child high-water including Node and MAT, NOT kernel or device RAM. Nearest-rank three-sample p95 is sample max.',
    sequence, rows, summaries,
  };
  writeFileSync(file(resultPath), `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
  console.log(`R3_HOST_BENCHMARK resultSha256=${hash(resultPath)} freezeSha256=${hash(freezePath)}`);
  console.log(JSON.stringify(summaries));
}
const [command, method, name] = process.argv.slice(2);
if (command === 'freeze') freeze();
else if (command === 'run') run();
else if (command === 'child' &&
    ['generic', 'scalar'].includes(method) && protocol.files.includes(name)) {
  process.stdout.write(`${JSON.stringify(child(method, name))}\n`);
} else throw new Error('Use freeze, run or fixed child.');
