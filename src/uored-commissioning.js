import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { biquad } from './uored-envelope-dsp.js';
import { random } from './data.js';
import { percentile } from './detector.js';

export const ALGORITHM = 'uored-band-rms-10-15k-commission-v1';
export const PREFIX_WINDOWS = 32;
export const RAW_WINDOW = 5376;
export const RAW_START = 500;
export const PREFIX_SAMPLES = RAW_START + PREFIX_WINDOWS * RAW_WINDOW;
export const TOTAL_WINDOWS = 77;
const Q = [0.541196100146197, 1.306562964876377];
const VARIANTS = ['clean-prefix-p95', 'augmented-prefix-p95'];
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function validateConfig(config, enforceSupported = true) {
  if (!config || typeof config !== 'object' ||
      !['deviceId', 'sensorId'].every((key) => typeof config[key] === 'string' &&
        config[key].trim().length > 0 && config[key].length <= 128) ||
      !Number.isFinite(config.gain) || config.gain <= 0 ||
      !Number.isSafeInteger(config.sampleRateHz) || config.sampleRateHz <= 0 ||
      typeof config.algorithmVersion !== 'string' || !config.algorithmVersion ||
      Object.keys(config).sort().join() !== 'algorithmVersion,deviceId,gain,sampleRateHz,sensorId') {
    throw new RangeError('Explicit device/sensor/gain/42kHz/algorithm configuration required.');
  }
  if (enforceSupported && (![0.5, 1, 2].includes(config.gain) ||
      config.sampleRateHz !== 42000 || config.algorithmVersion !== ALGORITHM)) {
    throw new RangeError('Only the fixed 42kHz/10-15kHz algorithm and declared gains can be commissioned.');
  }
  return config;
}

function timeUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !==
      new Date(Date.parse(value)).toISOString()) {
    throw new RangeError('Valid explicit UTC timestamp required.');
  }
  return Date.parse(value);
}

function seedFor(recording, phase) {
  let seed = phase === 'commission' ? 20261027 : 20261026;
  for (const c of `${recording}:${phase}`) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  return seed;
}

export function prefixNoiseRms(prefix, gain = 1) {
  if (!(prefix instanceof Float64Array) || prefix.length !== PREFIX_SAMPLES ||
      prefix.some((v) => !Number.isFinite(v) || Math.abs(v) > 1000) ||
      ![0.5, 1, 2].includes(gain)) {
    throw new RangeError('Health-confirmed raw PREFIX samples required to set synthetic noise power.');
  }
  const slice = prefix.subarray(RAW_START);
  const mean = slice.reduce((sum, x) => sum + x, 0) / slice.length;
  const power = slice.reduce((sum, x) => sum + (x - mean) ** 2, 0) / slice.length;
  const rms = Math.sqrt(power) * gain;
  if (!(rms >= 1e-12)) throw new RangeError('Zero healthy prefix AC energy; cannot commission.');
  return rms / 10;
}

export function bandRms(raw, { count, gain = 1, noiseRms = 0, recording = '', phase = 'query' }) {
  if (!(raw instanceof Float64Array) || ![PREFIX_WINDOWS, TOTAL_WINDOWS].includes(count) ||
      raw.length !== RAW_START + count * RAW_WINDOW || ![0.5, 1, 2].includes(gain) ||
      !(Number.isFinite(noiseRms) && noiseRms >= 0) ||
      (noiseRms && (typeof recording !== 'string' || !recording || !['commission', 'query'].includes(phase)))) {
    throw new RangeError('Exactly aligned raw input and declared filter/noise settings required.');
  }
  const sections = [...Q.map((q) => biquad('high', 10000, q)),
    ...Q.map((q) => biquad('low', 15000, q))];
  const rng = noiseRms ? random(seedFor(recording, phase)) : null;
  const scores = new Array(count).fill(null);
  let sumSquares = 0;
  const begun = performance.now();
  for (let i = 0; i < raw.length; i++) {
    const original = raw[i];
    if (!Number.isFinite(original) || Math.abs(original) > 1000) {
      throw new RangeError(`Nonfinite/out-of-range 42kHz sample at ${i}; no normal fallback.`);
    }
    let value = original * gain;
    if (rng) {
      value += noiseRms * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    }
    for (const s of sections) {
      const y = s.b0 * value + s.z1;
      s.z1 = s.b1 * value - s.a1 * y + s.z2;
      s.z2 = s.b2 * value - s.a2 * y;
      value = y;
    }
    if (!Number.isFinite(value)) throw new RangeError('Unstable/nonfinite bandpass output.');
    if (i >= RAW_START) {
      sumSquares += value * value;
      if ((i + 1 - RAW_START) % RAW_WINDOW === 0) {
        const index = (i + 1 - RAW_START) / RAW_WINDOW - 1;
        const rms = Math.sqrt(sumSquares / RAW_WINDOW);
        scores[index] = rms >= 1e-12 && Number.isFinite(rms) ? rms : null;
        sumSquares = 0;
      }
    }
  }
  if (scores.length !== count || scores.some((v) => v === undefined)) {
    throw new Error('Missing aligned band-energy windows.');
  }
  return { scores, prepMs: performance.now() - begun,
    centerFirstNumerator: 1000, centerStepNumerator: 21 * 512, centerDenominator: 2 };
}

export function commission({ healthConfirmed, config, variant, prefixBandRms, augmentedBandRms,
  commissionedAtUtc }) {
  validateConfig(config);
  const epoch = timeUtc(commissionedAtUtc);
  if (healthConfirmed !== true) throw new Error('Confirmed healthy assertion required; refuse commissioning.');
  if (!VARIANTS.includes(variant) || !Array.isArray(prefixBandRms) ||
      prefixBandRms.length !== PREFIX_WINDOWS ||
      prefixBandRms.some((v) => !Number.isFinite(v) || v < 1e-12)) {
    throw new RangeError('32 valid healthy prefix RMS windows and fixed variant required.');
  }
  if (variant === VARIANTS[1] && (!Array.isArray(augmentedBandRms) ||
      augmentedBandRms.length !== PREFIX_WINDOWS ||
      augmentedBandRms.some((v) => !Number.isFinite(v) || v < 1e-12))) {
    throw new RangeError('Augmented variant needs exactly 32 valid synthetic prefix scores.');
  }
  if (variant === VARIANTS[0] && augmentedBandRms !== undefined) {
    throw new RangeError('Clean variant must not use augmented prefix.');
  }
  const cleanP95 = percentile(prefixBandRms, .95);
  const augmentedP95 = variant === VARIANTS[1] ? percentile(augmentedBandRms, .95) : null;
  return {
    schema: 'commissioned-high-band-v1', variant, config: structuredClone(config),
    commissionedAtUtc: new Date(epoch).toISOString(), prefixWindowCount: PREFIX_WINDOWS,
    threshold: Math.max(cleanP95, augmentedP95 ?? cleanP95), cleanP95, augmentedP95,
    healthAssertion: 'operator-confirmed; not independently proven',
    sourceScope: 'first 32 healthy windows only; no automatic updating',
  };
}

export function referenceHash(reference) {
  return createHash('sha256').update(JSON.stringify(reference)).digest('hex');
}

export function decide(reference, { config, score, atUtc }) {
  validateConfig(config, false);
  const now = timeUtc(atUtc);
  if (reference === null || reference === undefined) {
    return { decision: 'requires-reference', reason: 'no-confirmed-healthy-reference' };
  }
  if (reference.schema !== 'commissioned-high-band-v1' ||
      !VARIANTS.includes(reference.variant) || reference.prefixWindowCount !== PREFIX_WINDOWS ||
      reference.healthAssertion !== 'operator-confirmed; not independently proven' ||
      !(Number.isFinite(reference.threshold) && reference.threshold > 0) ||
      !(Number.isFinite(reference.cleanP95) && reference.cleanP95 > 0) ||
      (reference.variant === VARIANTS[0] && reference.augmentedP95 !== null) ||
      (reference.variant === VARIANTS[1] &&
        !(Number.isFinite(reference.augmentedP95) && reference.augmentedP95 > 0)) ||
      reference.threshold !== Math.max(reference.cleanP95, reference.augmentedP95 ?? reference.cleanP95)) {
    throw new RangeError('Malformed/untrusted reference; do not infer normal.');
  }
  validateConfig(reference.config);
  const age = now - timeUtc(reference.commissionedAtUtc);
  if (Object.keys(reference.config).some((key) => reference.config[key] !== config[key]) ||
      age < 0 || age > MAX_AGE_MS) {
    return { decision: 'requires-recalibration', reason: age < 0 || age > MAX_AGE_MS ?
      'reference-expired-or-clock-mismatch' : 'device-sensor-gain-rate-or-algorithm-changed' };
  }
  if (!(Number.isFinite(score) && score >= 1e-12)) {
    return { decision: 'abstain', reason: 'invalid-band-energy; inspect-sensor' };
  }
  return { decision: score > reference.threshold ? 'anomaly' : 'normal',
    score, threshold: reference.threshold, referenceSha256: referenceHash(reference) };
}

if (process.argv[1]?.endsWith('uored-commissioning.js')) {
  try {
    const [, , action, input, output] = process.argv;
    if (!['commission', 'decide'].includes(action) || !input || !output) {
      throw new Error('Usage: node src\\uored-commissioning.js commission|decide input.json output.json');
    }
    const payload = JSON.parse(readFileSync(input, 'utf8'));
    const result = action === 'commission' ? commission(payload) : decide(payload.reference, payload.query);
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    console.log(`${action} ${result.decision ?? 'reference-created'} -> ${output}`);
  } catch (error) {
    console.error(`Commissioning blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
