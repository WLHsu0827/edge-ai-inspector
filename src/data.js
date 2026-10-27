import { DEFAULT_SEED, SAMPLE_RATE_HZ, WINDOW_SAMPLES, integer } from './config.js';

export const KINDS = Object.freeze(['normal', 'burst', 'impulse', 'imbalance', 'high-tone']);
export const DATA_NOTICE = 'SYNTHETIC DEMO ONLY - no real industrial data or hardware validation.';
export const SPLIT_SALTS = Object.freeze({
  fit: 0x13579bdf, calibration: 0x2468ace0,
  validation: 0x9e3779b9, test: 0x85ebca6b, demo: 0xc2b2ae35,
});

export function random(seed) {
  let state = integer(seed, 'seed', 0, 0xffffffff);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSignal(kind, rng) {
  if (!KINDS.includes(kind)) throw new RangeError(`Unknown example kind: ${kind}`);
  const signal = new Float64Array(WINDOW_SAMPLES);
  const frequency = 128 + (rng() - 0.5) * 3;
  const amplitude = 0.8 + rng() * 0.4;
  const harmonic = 0.15 + rng() * 0.1;
  const noise = 0.02 + rng() * 0.02;
  const phase = rng() * 2 * Math.PI;
  const phase2 = rng() * 2 * Math.PI;
  const faultFrequency = rng() < 0.5 ? 336 : 464;
  const faultAmplitude = 0.12 + rng() * 0.1;
  for (let i = 0; i < signal.length; i++) {
    const time = i / SAMPLE_RATE_HZ;
    const gaussian = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    signal[i] = amplitude * Math.sin(2 * Math.PI * frequency * time + phase)
      + harmonic * Math.sin(4 * Math.PI * frequency * time + phase2) + noise * gaussian;
    if (kind === 'imbalance') signal[i] += 0.45 * Math.sin(2 * Math.PI * 32 * time + phase2);
    if (kind === 'high-tone') {
      signal[i] += faultAmplitude * Math.sin(2 * Math.PI * faultFrequency * time + phase2);
    }
  }
  if (kind === 'burst') {
    const start = Math.floor(rng() * 320);
    for (let i = start; i < start + 96; i++) signal[i] *= 1.8;
  }
  if (kind === 'impulse') {
    for (let i = 0; i < 3; i++) {
      signal[Math.floor(rng() * signal.length)] += (rng() < 0.5 ? -1 : 1) * (3 + rng());
    }
  }
  return signal;
}

export function makeExample(kind, seed = DEFAULT_SEED) {
  const rng = random((integer(seed, 'seed', 0, 0xffffffff) ^ SPLIT_SALTS.demo) >>> 0);
  return generateSignal(kind, rng);
}

export function makeDataset({ seed = DEFAULT_SEED, validationSize = 160, testSize = 240 } = {}) {
  integer(seed, 'seed', 0, 0xffffffff);
  for (const [name, size] of [['validationSize', validationSize], ['testSize', testSize]]) {
    integer(size, name, 8, 2000);
    if (size % 8 !== 0) throw new RangeError(`${name} must be divisible by 8.`);
  }
  function normalSplit(name, count) {
    const rng = random((seed ^ SPLIT_SALTS[name]) >>> 0);
    return Array.from({ length: count }, () => generateSignal('normal', rng));
  }
  function mixedSplit(name, count) {
    const rng = random((seed ^ SPLIT_SALTS[name]) >>> 0);
    const rows = Array.from({ length: count }, (_, i) => {
      const kind = i < count / 2 ? 'normal' : KINDS[1 + (i % 4)];
      return { signal: generateSignal(kind, rng), kind, anomaly: kind !== 'normal' };
    });
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows;
  }
  return {
    fit: normalSplit('fit', 128),
    calibration: normalSplit('calibration', 80),
    validation: mixedSplit('validation', validationSize),
    test: mixedSplit('test', testSize),
  };
}
