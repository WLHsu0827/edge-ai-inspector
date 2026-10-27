import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './evidence.js';
import { readFiniteAcceleration } from './uored-finite-domain.js';
import { PREFIX_SAMPLES, RAW_START, RAW_WINDOW, prefixNoiseRms } from './uored-commissioning.js';
import { extract } from './uored-structure-dsp.js';
import { extractScalar } from './uored-scalar-kernel-r3.js';
import { commission, config, decide, referenceHash } from './uored-structure-core.js';
import { percentile } from './detector.js';

const output = join(ROOT, 'results/uored-scalar-kernel-parity-r3-2026-10-26.json');
const names = ['H_1_0.mat', 'H_6_0.mat', 'H_2_0.mat', 'H_7_0.mat',
  'H_3_0.mat', 'H_8_0.mat', 'I_3_2.mat', 'O_8_2.mat'];
const conditions = ['original', 'matched-gain-0.5', 'matched-gain-2',
  'query-white-20dB', 'query-ar1-20dB'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const load = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const hash = (path) => sha(readFileSync(join(ROOT, path)));
const plan = load('datasets/uored-paired-pilot-2026-10-25.json');
const old = load('results/uored-scalar-kernel-parity-2026-10-26.json');
const saved = load('results/uored-structure-development-2026-10-26.json')
  .methods.find((method) => method.id === 'matched-scalar');
if (existsSync(output) || old.exact !== true || old.perConditionRows.length !== 40 ||
    old.fitReferences.length !== 18 || saved?.screen.pass !== true) {
  throw new Error('r3 output exists or original development evidence changed.');
}
const metadata = new Map(plan.records.filter((row) => names.includes(row.name))
  .map((row) => [row.name, row]));
if (metadata.size !== 8 || names.some((name) =>
  old.inputHashes[name] !== metadata.get(name).sha256)) {
  throw new Error('Development-only allowlist/hash changed.');
}
function raw(name) {
  if (!names.includes(name)) throw new Error('Forbidden waveform identity.');
  const meta = metadata.get(name), path = join(plan.destinationDirectory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== meta.bytes) {
    throw new Error('Publisher type/size mismatch.');
  }
  const bytes = readFileSync(path);
  if (sha(bytes) !== meta.sha256) throw new Error('Publisher SHA mismatch.');
  const data = readFiniteAcceleration(bytes);
  if (data.variable !== name.slice(0, -4) || data.samples.length !== 420000) {
    throw new Error('Publisher MAT identity/shape mismatch.');
  }
  return data.samples;
}
function sameFeatures(samples, options) {
  const oldFeatures = extract(samples, options).features['matched-scalar'];
  const newFeatures = extractScalar(samples, options).features;
  for (let i = 0; i < oldFeatures.length; i++) {
    if (JSON.stringify(oldFeatures[i]) !== JSON.stringify(newFeatures[i])) {
      throw new Error(`Feature bits differ at frame ${i}.`);
    }
  }
  return newFeatures;
}
const references = new Map(), noises = new Map(), refRows = [];
for (const name of names.filter((n) => n.startsWith('H_'))) {
  const samples = raw(name).subarray(0, PREFIX_SAMPLES);
  const unit = Number(name.split('_')[1]);
  noises.set(unit, prefixNoiseRms(samples));
  for (const gain of [1, .5, 2]) {
    const clean = sameFeatures(samples, { count: 32, gain });
    const noiseRms = prefixNoiseRms(samples, gain);
    const white = sameFeatures(samples, { count: 32, gain, noiseRms,
      phase: 'commission', recording: name });
    const colored = sameFeatures(samples, { count: 32, gain, noiseRms,
      phase: 'commission-colored', recording: name });
    const ref = commission({ healthConfirmed: true, methodId: 'matched-scalar',
      installationConfig: config(unit, gain), clean, white, colored });
    const previous = old.fitReferences.find((row) => row.unit === unit && row.gain === gain);
    if (referenceHash(ref) !== previous?.sha256 ||
        ref.threshold !== previous.threshold ||
        JSON.stringify(ref.p95) !== JSON.stringify(previous.p95)) {
      throw new Error(`Reference parity failed at unit ${unit}, gain ${gain}`);
    }
    references.set(`${unit}:${gain}`, ref);
    refRows.push({ unit, gain, referenceSha256: referenceHash(ref),
      threshold: ref.threshold, p95: ref.p95 });
  }
}
const rows = [];
for (const name of names) {
  const samples = raw(name).subarray(0, RAW_START + 77 * RAW_WINDOW);
  const unit = Number(name.split('_')[1]), healthy = name.startsWith('H_');
  for (const condition of conditions) {
    const gain = condition === 'matched-gain-0.5' ? .5 :
      condition === 'matched-gain-2' ? 2 : 1;
    const options = { count: 77, gain, recording: name,
      phase: condition === 'query-ar1-20dB' ? 'query-colored' : 'query',
      noiseRms: condition.startsWith('query-') ? noises.get(unit) : 0 };
    const features = sameFeatures(samples, options), ref = references.get(`${unit}:${gain}`);
    if (!ref) throw new Error(`No paired development reference ${name}.`);
    const scores = [], tally = { fp: 0, tn: 0, tp: 0, fn: 0,
      abstainPositive: 0, abstainNegative: 0 };
    for (let i = healthy ? 32 : 0; i < 77; i++) {
      const answer = decide(ref, { feature: features[i], installationConfig: ref.config });
      if (answer.decision === 'abstain') tally[healthy ? 'abstainNegative' : 'abstainPositive']++;
      else if (answer.decision === 'normal' || answer.decision === 'anomaly') {
        scores.push(answer.score);
        tally[healthy ? answer.decision === 'normal' ? 'tn' : 'fp' :
          answer.decision === 'normal' ? 'fn' : 'tp']++;
      } else throw new Error('Valid reference refused.');
    }
    const previous = old.perConditionRows.find((row) =>
      row.name === name && row.condition === condition);
    if (!previous || referenceHash(ref) !== previous.referenceSha256 ||
        Object.entries(tally).some(([key, value]) => previous[key] !== value) ||
        (scores.length && (Math.min(...scores) !== previous.scoreMin ||
          percentile(scores, .5) !== previous.scoreMedian ||
          Math.max(...scores) !== previous.scoreMax))) {
      throw new Error(`Archived score/decision parity failed at ${name}/${condition}.`);
    }
    rows.push({ name, condition, n: healthy ? 45 : 77,
      referenceSha256: referenceHash(ref), ...tally,
      min: previous.scoreMin, median: previous.scoreMedian, max: previous.scoreMax });
  }
}
for (const name of ['I_3_2.mat', 'O_8_2.mat']) {
  const samples = raw(name).subarray(0, RAW_START + 77 * RAW_WINDOW);
  const ref = references.get(`${Number(name.split('_')[1])}:1`);
  for (const gain of [.5, 2]) {
    const features = sameFeatures(samples, { count: 77, gain });
    const decisions = features.map((feature) => decide(ref, {
      feature, installationConfig: ref.config }).decision);
    const prior = saved.unreportedGain.find((row) =>
      row.name === name && row.condition === `unreported-gain-${gain}`);
    if (decisions.filter((x) => x === 'anomaly').length !== prior?.tp ||
        decisions.filter((x) => x === 'normal').length !== prior.fn) {
      throw new Error(`Unreported-gain decision mismatch ${name}/${gain}`);
    }
  }
}
const record = {
  id: 'scalar-r3-development-implementation-parity',
  scope: 'Eight previously seen development recordings ONLY; no consumed target waveform access or new performance claim',
  v1ParitySha256: hash('results/uored-scalar-kernel-parity-2026-10-26.json'),
  sourceHashes: Object.fromEntries([
    'src/uored-scalar-kernel-r3.js', 'src/uored-scalar-parity-r3.js',
    'src/uored-structure-dsp.js', 'src/uored-structure-core.js',
    'datasets/uored-paired-pilot-2026-10-25.json',
  ].map((path) => [path, hash(path)])),
  inputSha256ByName: old.inputHashes,
  exact: true, prefixReferences: refRows, rows,
  checks: { prefixReferenceHashes: 18, queryConditionRows: 40,
    syntheticLifecycleTestsSeparate: true, archivedMinMedianMaxAndCounts: true,
    faultUnreportedGainRows: 4 },
  limitation: 'Finite extreme values can trigger generic unused-envelope errors that scalar-only does not reproduce. This is not target-quality validation.',
};
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
console.log(`R3_PARITY_EXACT references=${refRows.length} rows=${rows.length} sha256=${sha(readFileSync(output))}`);
