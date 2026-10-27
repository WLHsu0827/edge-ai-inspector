import { fft } from './research-model.js';
import { random } from './data.js';

export const SOURCE_RATE = 42000;
export const OUTPUT_SAMPLES = 39905;
export const WINDOW_COUNT = 77;
export const WINDOW_RAW = 5376;
export const BANDS = [[2000, 5000], [5000, 10000], [10000, 15000]];
const Q4 = [0.541196100146197, 1.306562964876377];
const HANN = Float64Array.from({ length: 512 }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / 511));

export function biquad(kind, cutoff, q) {
  if (!['high', 'low'].includes(kind) || !(cutoff > 0 && cutoff < SOURCE_RATE / 2) || !(q > 0)) {
    throw new RangeError('Invalid biquad design.');
  }
  const omega = 2 * Math.PI * cutoff / SOURCE_RATE;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  const normalizer = 1 + alpha;
  const c = kind === 'low' ? (1 - cosine) / 2 : (1 + cosine) / 2;
  return {
    b0: c / normalizer, b1: (kind === 'low' ? 2 : -2) * c / normalizer,
    b2: c / normalizer, a1: -2 * cosine / normalizer,
    a2: (1 - alpha) / normalizer, z1: 0, z2: 0,
  };
}

function step(x, sections) {
  for (const s of sections) {
    const y = s.b0 * x + s.z1;
    s.z1 = s.b1 * x - s.a1 * y + s.z2;
    s.z2 = s.b2 * x - s.a2 * y;
    x = y;
  }
  return x;
}

export function centeredStress(raw, condition, name) {
  if (!(raw instanceof Float64Array) || raw.length < 10000 ||
      raw.some((v) => !Number.isFinite(v) || Math.abs(v) > 1000)) {
    throw new RangeError('Invalid 42k raw vibration.');
  }
  if (!['original', 'gain-0.5', 'gain-2', 'noise-20dB'].includes(condition)) {
    throw new RangeError('Unknown stress.');
  }
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const ac = Float64Array.from(raw, (v) => v - mean);
  const rms = Math.sqrt(ac.reduce((sum, x) => sum + x * x, 0) / ac.length);
  if (!(rms >= 1e-12)) throw new RangeError('Zero/near-zero raw AC: invalid, never normal.');
  if (condition.startsWith('gain-')) {
    const gain = condition === 'gain-2' ? 2 : 0.5;
    for (let i = 0; i < ac.length; i++) ac[i] *= gain;
  } else if (condition === 'noise-20dB') {
    let seed = 20260926;
    for (const char of `${name}:raw-ac`) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    const rng = random(seed);
    for (let i = 0; i < ac.length; i++) {
      const u = rng(), phase = rng();
      ac[i] += rms / 10 * Math.sqrt(-2 * Math.log(1 - u)) * Math.cos(2 * Math.PI * phase);
    }
  }
  return { ac, originalMean: mean, originalCenteredRms: rms };
}

export function acRmsWindows(ac) {
  if (!(ac instanceof Float64Array) || ac.length < 500 + WINDOW_COUNT * WINDOW_RAW) {
    throw new RangeError('Insufficient AC samples for aligned windows.');
  }
  const values = new Float64Array(WINDOW_COUNT);
  for (let w = 0; w < WINDOW_COUNT; w++) {
    let sum = 0;
    const first = 500 + w * WINDOW_RAW;
    for (let i = first; i < first + WINDOW_RAW; i++) sum += ac[i] * ac[i];
    values[w] = Math.sqrt(sum / WINDOW_RAW);
  }
  return values;
}

export function envelopeFeatures(samples) {
  if (samples.length !== 512 || samples.some((v) => !Number.isFinite(v))) {
    throw new RangeError('Invalid envelope window.');
  }
  const mean = samples.reduce((sum, v) => sum + v, 0) / 512;
  let power = 0;
  for (const value of samples) power += (value - mean) ** 2;
  const scale = Math.sqrt(power / 512);
  if (!(scale >= 1e-12)) throw new RangeError('Zero/near-zero envelope modulation: invalid, never normal.');
  const re = new Float64Array(512), im = new Float64Array(512);
  for (let i = 0; i < 512; i++) re[i] = (samples[i] - mean) / scale * HANN[i];
  fft(re, im);
  const bands = new Float64Array(16);
  let total = 0;
  for (let bin = 1; bin <= 256; bin++) {
    const p = re[bin] ** 2 + im[bin] ** 2;
    bands[Math.floor((bin - 1) / 16)] += p;
    total += p;
  }
  if (!(total > 0) || !Number.isFinite(total)) throw new RangeError('Invalid envelope spectrum.');
  return Float64Array.from(bands, (p) => Math.log((p / total + 1e-12) / (1 + 16e-12)));
}

export function preprocessBand(ac, lower, upper) {
  if (!(ac instanceof Float64Array) || ac.length !== 420000 ||
      !BANDS.some(([lo, hi]) => lo === lower && hi === upper)) {
    throw new RangeError('Invalid predeclared band or raw length.');
  }
  const bandpass = [
    ...Q4.map((q) => biquad('high', lower, q)),
    ...Q4.map((q) => biquad('low', upper, q)),
  ];
  const movingAverages = Array.from({ length: 3 }, () => ({
    buffer: new Float64Array(42), sum: 0, offset: 0,
  }));
  const power = new Float64Array(ac.length);
  const energies = new Float64Array(WINDOW_COUNT);
  let roundedNegativeCount = 0;
  for (let i = 0; i < ac.length; i++) {
    const filtered = step(ac[i], bandpass);
    if (!Number.isFinite(filtered)) throw new RangeError('Nonfinite high-frequency band output.');
    const squared = filtered * filtered;
    if (i >= 500 && i < 500 + WINDOW_COUNT * WINDOW_RAW) {
      energies[Math.floor((i - 500) / WINDOW_RAW)] += squared;
    }
    let smoothed = squared;
    for (const stage of movingAverages) {
      stage.sum += smoothed - stage.buffer[stage.offset];
      stage.buffer[stage.offset] = smoothed;
      stage.offset = (stage.offset + 1) % stage.buffer.length;
      smoothed = stage.sum / stage.buffer.length;
    }
    if (!Number.isFinite(smoothed) || smoothed < -1e-10) {
      throw new RangeError('Nonfinite or materially negative square-law envelope.');
    }
    if (smoothed < 0) roundedNegativeCount++;
    power[i] = Math.max(0, smoothed);
  }
  const envelope = new Float64Array(OUTPUT_SAMPLES);
  for (let n = 0; n < OUTPUT_SAMPLES; n++) {
    const twiceCenter = 1000 + 21 * n;
    const index = Math.floor(twiceCenter / 2);
    envelope[n] = twiceCenter % 2 ? (power[index] + power[index + 1]) / 2 : power[index];
  }
  return {
    envelope, bandRms: Float64Array.from(energies, (sum) => Math.sqrt(sum / WINDOW_RAW)),
    roundedNegativeCount,
    alignment: { firstSourceCenter: 500, lastSourceCenter: 500 + (OUTPUT_SAMPLES - 1) * 10.5,
      windowRawSamples: WINDOW_RAW, envelopeWindowSamples: 512, windows: WINDOW_COUNT,
      unusedOutputTail: OUTPUT_SAMPLES - WINDOW_COUNT * 512 },
  };
}

export function featuresByWindow(envelope) {
  if (!(envelope instanceof Float64Array) || envelope.length !== OUTPUT_SAMPLES) {
    throw new RangeError('Unexpected resampled square-law envelope.');
  }
  const features = [];
  for (let w = 0; w < WINDOW_COUNT; w++) {
    const input = envelope.subarray(w * 512, (w + 1) * 512);
    try {
      features.push(envelopeFeatures(input));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      features.push(null);
    }
  }
  return features;
}
