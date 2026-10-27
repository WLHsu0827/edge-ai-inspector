import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScalarStream, extractScalar } from '../src/uored-scalar-kernel-r3.js';
import { extract } from '../src/uored-structure-dsp.js';
import { RAW_START, RAW_WINDOW } from '../src/uored-commissioning.js';
import { config, commission, decide, referenceHash } from '../src/uored-structure-core.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const raw = (count) => Float64Array.from({ length: RAW_START + count * RAW_WINDOW },
  (_, i) => Math.sin(i * .77) + .3 * Math.sin(i * 1.23));

test('new kernel preserves frozen scalar bits across chunk sizes and synthetic noise', () => {
  for (const count of [32, 77]) {
    const samples = raw(count);
    for (const condition of [{ gain: 1 }, { gain: .5, noiseRms: .07,
      recording: 'synthetic', phase: 'commission-colored' }]) {
      const previous = extract(samples, { count, ...condition });
      for (const chunkSize of [1, 499, 5376, 8191, samples.length]) {
        const current = extractScalar(samples, { count, chunkSize, ...condition });
        assert.deepEqual(current.power, previous.power);
        assert.deepEqual(current.features, previous.features['matched-scalar']);
      }
    }
  }
});

test('failed final sample and intermediate failure permanently poison the stream', () => {
  const length = RAW_START + 32 * RAW_WINDOW;
  for (const bad of [NaN, Infinity, -Infinity, 1e200]) {
    const stream = new ScalarStream(32);
    stream.push(new Float64Array(length - 1));
    assert.throws(() => stream.push(Float64Array.of(bad)), RangeError);
    assert.throws(() => stream.finish(), /failed/);
    assert.throws(() => stream.push(Float64Array.of(0)), /failed/);
  }
  const stream = new ScalarStream(32);
  stream.push(new Float64Array(400));
  assert.throws(() => stream.push(Float64Array.of(NaN, 1)), RangeError);
  assert.throws(() => stream.push(new Float64Array(length - 400)), /failed/);
  assert.throws(() => stream.finish(), /failed/);
});

test('double finish and post-finish push refuse without changing output; incomplete fails', () => {
  const samples = new Float64Array(RAW_START + 32 * RAW_WINDOW);
  samples[samples.length - 1] = 1;
  const stream = new ScalarStream(32);
  stream.push(samples.subarray(0, 503));
  stream.push(samples.subarray(503));
  const result = stream.finish();
  const snapshot = structuredClone(result);
  assert.ok(result.features[31][0] > 0);
  assert.throws(() => stream.finish(), /finished/);
  assert.throws(() => stream.push(Float64Array.of(0)), /finished/);
  assert.deepEqual(result, snapshot);
  const incomplete = new ScalarStream(32);
  incomplete.push(samples.subarray(0, samples.length - 1));
  assert.throws(() => incomplete.finish(), RangeError);
  assert.throws(() => incomplete.push(Float64Array.of(1)), /failed/);
});

test('reference decisions, declared mismatch and hidden gain retain baseline behavior', () => {
  const prefix = raw(32), opts = { count: 32 };
  const conditions = [
    {},
    { noiseRms: .05, recording: 'synthetic', phase: 'commission' },
    { noiseRms: .05, recording: 'synthetic', phase: 'commission-colored' },
  ];
  const makeRef = (gain, extractor) => {
    const [clean, white, colored] = conditions.map((condition) => {
      const result = extractor(prefix, { ...opts, gain, ...condition });
      return extractor === extract ? result.features['matched-scalar'] : result.features;
    });
    return commission({ healthConfirmed: true, methodId: 'matched-scalar',
      installationConfig: config(1, gain), clean, white, colored });
  };
  const original = makeRef(1, extract);
  for (const gain of [1, .5, 2]) {
    const ref = makeRef(gain, extractScalar);
    const genericRef = makeRef(gain, extract);
    assert.deepEqual(ref, genericRef);
    assert.equal(referenceHash(ref), referenceHash(genericRef));
    const actual = extractScalar(prefix, { ...opts, gain }).features;
    const expected = extract(prefix, { ...opts, gain }).features['matched-scalar'];
    assert.deepEqual(actual, expected);
    for (let i = 0; i < actual.length; i++) {
      assert.deepEqual(decide(ref, { feature: actual[i],
        installationConfig: ref.config }), decide(genericRef, {
        feature: expected[i], installationConfig: genericRef.config }));
      assert.deepEqual(decide(original, { feature: actual[i],
        installationConfig: original.config }), decide(original, {
        feature: expected[i], installationConfig: original.config }));
    }
  }
  const clean = extractScalar(prefix, opts).features;
  assert.equal(decide(original, { feature: clean[0],
    installationConfig: config(1, 2) }).decision, 'requires-recalibration');
  assert.equal(decide(null, { feature: clean[0],
    installationConfig: config(1, 1) }).decision, 'requires-reference');
});

function cli(args) {
  return spawnSync(process.execPath, ['--single-threaded', '--v8-pool-size=1',
    join(root, 'src/uored-scalar-demo-r3.js'), ...args],
  { cwd: root, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
}

test('independent query scores early fault frames; strict flags and create-only output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asus-scalar-r3-'));
  try {
    const healthy = join(dir, 'healthy.txt'), query = join(dir, 'query.txt');
    const prefix = raw(32);
    const recording = raw(77);
    for (let i = RAW_START; i < RAW_START + 32 * RAW_WINDOW; i++) {
      recording[i] += 2 * Math.sin(i * 1.9);
    }
    writeFileSync(healthy, [...prefix].join('\n'));
    writeFileSync(query, [...recording].join('\n'));
    const args = ['files', '--healthy', healthy, '--query', query,
      '--device-id', 'demo-unit', '--health-confirmed'];
    const success = cli(args);
    assert.equal(success.status, 0, success.stderr);
    const result = JSON.parse(success.stdout);
    assert.equal(result.queryFrames, 77);
    assert.equal(result.scoredFrameStart, 0);
    assert.equal(result.excludedQueryFrames, 0);
    assert.equal(result.decisions[0].frame, 0);
    assert.ok(result.decisions.slice(0, 32).some((row) => row.decision === 'anomaly'));
    assert.ok(result.decisions.slice(32).every((row) => row.decision === 'normal'));
    for (const extra of [['--gain', '2'], ['--device-id', 'duplicate'],
      ['--query'], ['--unknown'], ['unparsed']]) {
      const rejected = cli([...args, ...extra]);
      assert.notEqual(rejected.status, 0, `Accepted forbidden CLI args: ${extra}`);
    }
    const path = join(dir, 'export.json');
    assert.equal(cli([...args, '--output', path]).status, 0);
    assert.ok(existsSync(path));
    assert.notEqual(cli([...args, '--output', path]).status, 0);
    assert.notEqual(cli(['files', '--healthy', healthy, '--query', query,
      '--device-id', 'demo-unit']).status, 0);
    const synthetic = cli(['synthetic']);
    assert.equal(synthetic.status, 0, synthetic.stderr);
    const demo = JSON.parse(synthetic.stdout);
    assert.equal(demo.queryFrames, 45);
    assert.equal(demo.scoredFrameStart, 32);
    assert.equal(demo.excludedQueryFrames, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
