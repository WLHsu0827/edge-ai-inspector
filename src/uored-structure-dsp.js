import { performance } from 'node:perf_hooks';
import { biquad } from './uored-envelope-dsp.js';
import { random } from './data.js';
import { RAW_START, RAW_WINDOW, PREFIX_WINDOWS, TOTAL_WINDOWS }
  from './uored-commissioning.js';

export const BANDS = Object.freeze([[2000, 5000], [5000, 10000], [10000, 15000]]);
export const METHODS = Object.freeze(['matched-scalar', 'band-contrast', 'band-contrast-periodicity']);
const Q = [0.541196100146197, 1.306562964876377];
const ENVELOPE_PER_FRAME = 128;
const SMOOTH = 84;
const RHO = 0.8;

function sections(lo, hi) {
  return [...Q.map((q) => biquad('high', lo, q)),
    ...Q.map((q) => biquad('low', hi, q))];
}

function step(value, filters, at) {
  for (const filter of filters) {
    const y = filter.b0 * value + filter.z1;
    const z1 = filter.b1 * value - filter.a1 * y + filter.z2;
    const z2 = filter.b2 * value - filter.a2 * y;
    if (![y, z1, z2].every(Number.isFinite)) throw new RangeError(`Filter overflow at ${at}`);
    filter.z1 = z1;
    filter.z2 = z2;
    value = y;
  }
  return value;
}

export function whiteNoiseGains(length = 4096) {
  if (length !== 4096) throw new RangeError('Fixed 4096-tap impulse measurement only.');
  return BANDS.map(([lo, hi]) => {
    const filters = sections(lo, hi);
    let energy = 0, tailEnergy = 0;
    for (let i = 0; i < length; i++) {
      const y = step(i === 0 ? 1 : 0, filters, i);
      energy += y * y;
      if (i >= length - 128) tailEnergy += y * y;
    }
    if (!(energy > 1e-8 && Number.isFinite(energy)) ||
        tailEnergy / energy > 1e-12) throw new Error('Unsettled white-noise filter gain.');
    return energy;
  });
}
export const FILTER_GAINS = Object.freeze(whiteNoiseGains());

function seedFor(recording, phase) {
  const colored = phase.includes('colored');
  let seed = colored ? (phase === 'commission-colored' ? 20261030 : 20261029) :
    phase === 'commission' ? 20261027 : 20261026;
  for (const c of `${recording}:${phase}`) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  return seed;
}

export function inject(raw, { gain = 1, noiseRms = 0, phase = 'query', recording = '' } = {}) {
  if (!(raw instanceof Float64Array) || ![1, .5, 2].includes(gain) ||
      !(Number.isFinite(noiseRms) && noiseRms >= 0) ||
      (noiseRms > 0 && (!recording || !['commission', 'query',
        'commission-colored', 'query-colored'].includes(phase)))) throw new RangeError('Invalid raw stress.');
  const out = new Float64Array(raw.length);
  const rng = noiseRms ? random(seedFor(recording, phase)) : null;
  let state = 0;
  for (let i = 0; i < raw.length; i++) {
    let v = raw[i] * gain;
    if (!Number.isFinite(v)) throw new RangeError(`Nonfinite raw/gain at ${i}`);
    if (rng) {
      const z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      if (phase.includes('colored')) {
        state = RHO * state + Math.sqrt(1 - RHO * RHO) * z;
        if (!Number.isFinite(state)) throw new RangeError(`Colored-noise overflow at ${i}`);
      }
      v += noiseRms * (phase.includes('colored') ? state : z);
    }
    if (!Number.isFinite(v)) throw new RangeError(`Noise addition overflow at ${i}`);
    out[i] = v;
  }
  return out;
}

function smoother() {
  return Array.from({ length: 3 }, () =>
    ({ buffer: new Float64Array(SMOOTH), sum: 0, at: 0 }));
}

export function extract(raw, { count, gain = 1, noiseRms = 0,
  recording = '', phase = 'query' }) {
  if (!(raw instanceof Float64Array) || ![PREFIX_WINDOWS, TOTAL_WINDOWS].includes(count) ||
      raw.length !== RAW_START + RAW_WINDOW * count) {
    throw new RangeError('Exact aligned 32/77 frame raw input required.');
  }
  const begin = performance.now();
  const stressed = inject(raw, { gain, noiseRms, recording, phase });
  const preparationStart = performance.now();
  const power = Array.from({ length: count }, () => [0, 0, 0]);
  const envelope = BANDS.map(() => new Float64Array(count * ENVELOPE_PER_FRAME));
  let roundedNegatives = 0;
  for (const [band, [lo, hi]] of BANDS.entries()) {
    const filters = sections(lo, hi);
    const stages = smoother();
    for (let i = 0; i < stressed.length; i++) {
      const filtered = step(stressed[i], filters, i);
      const square = filtered * filtered;
      if (!Number.isFinite(square)) throw new RangeError(`Square overflow at ${i}`);
      if (i >= RAW_START) {
        const frame = Math.floor((i - RAW_START) / RAW_WINDOW);
        power[frame][band] += square;
        if (!Number.isFinite(power[frame][band])) throw new RangeError(`Energy overflow at ${i}`);
      }
      let smooth = square;
      for (const stage of stages) {
        stage.sum += smooth - stage.buffer[stage.at];
        stage.buffer[stage.at] = smooth;
        stage.at = (stage.at + 1) % SMOOTH;
        if (!Number.isFinite(stage.sum) || stage.sum < -1e-9 * Math.max(1, square)) {
          throw new RangeError(`Invalid smoother at ${i}`);
        }
        if (stage.sum < 0) { roundedNegatives++; stage.sum = 0; }
        smooth = stage.sum / SMOOTH;
      }
      if (i >= RAW_START && (i - RAW_START) % 42 === 0) {
        envelope[band][(i - RAW_START) / 42] = smooth;
      }
    }
  }
  for (const values of power) for (let b = 0; b < 3; b++) {
    values[b] /= RAW_WINDOW * FILTER_GAINS[b];
    if (!Number.isFinite(values[b])) throw new RangeError('Nonfinite normalized band energy.');
  }
  const filterMs = performance.now() - preparationStart;
  const featureStart = performance.now();
  const features = buildFeatures(power, envelope);
  return { features, power, filterMs, featureMs: performance.now() - featureStart,
    stressMs: preparationStart - begin, roundedNegatives,
    rawNumericBytes: raw.byteLength, stressedNumericBytes: stressed.byteLength,
    envelopeNumericBytes: envelope.reduce((n, v) => n + v.byteLength, 0),
    powerNumericBytes: count * 3 * 8 };
}

export function periodicity(values) {
  if (!(values instanceof Float64Array) || values.length !== 512 ||
      values.some((v) => !Number.isFinite(v) || v < 0)) throw new RangeError('Invalid causal 512-point envelope.');
  const mean = values.reduce((a, b) => a + b, 0) / 512;
  const ac = Float64Array.from(values, (v) => v - mean);
  let full = 0;
  for (const v of ac) full += v * v;
  if (!(full >= 1e-24 && Number.isFinite(full))) return null;
  let best = 0;
  for (let lag = 4; lag <= 128; lag++) {
    let numerator = 0, left = 0, right = 0;
    for (let i = lag; i < 512; i++) {
      const a = ac[i - lag], b = ac[i];
      numerator += a * b;
      left += a * a;
      right += b * b;
    }
    const denominator = Math.sqrt(left * right);
    if (!Number.isFinite(denominator) || !Number.isFinite(numerator)) {
      throw new RangeError('Autocorrelation overflow.');
    }
    if (denominator > 0) best = Math.max(best, numerator / denominator);
  }
  return Math.min(1, best);
}

export function buildFeatures(powers, envelopes) {
  if (!Array.isArray(powers) || !Array.isArray(envelopes) || envelopes.length !== 3 ||
      powers.length * ENVELOPE_PER_FRAME !== envelopes[0].length ||
      envelopes.some((v) => !(v instanceof Float64Array) || v.length !== envelopes[0].length)) {
    throw new RangeError('Aligned three-band powers and envelopes required.');
  }
  const result = { 'matched-scalar': [], 'band-contrast': [], 'band-contrast-periodicity': [] };
  for (let frame = 0; frame < powers.length; frame++) {
    const p = powers[frame], sum = p.reduce((a, b) => a + b, 0);
    if (p.length !== 3 || p.some((v) => !Number.isFinite(v) || v < 0) || !Number.isFinite(sum)) {
      throw new RangeError('Invalid band powers.');
    }
    const valid = sum >= 1e-24 && p.some((v) => v >= 1e-24);
    const contrast = valid ? [(p[1] - p[0]) / sum, (p[2] - p[1]) / sum] : null;
    result['matched-scalar'].push(valid ? [sum] : null);
    result['band-contrast'].push(contrast);
    if (!contrast || frame < 3) {
      result['band-contrast-periodicity'].push(null);
      continue;
    }
    const peaks = envelopes.map((values) =>
      periodicity(values.subarray((frame - 3) * ENVELOPE_PER_FRAME,
        (frame + 1) * ENVELOPE_PER_FRAME)));
    result['band-contrast-periodicity'].push(peaks.every((v) => v !== null) ?
      [...contrast, ...peaks] : null);
  }
  return result;
}
