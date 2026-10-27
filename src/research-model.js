import { performance } from 'node:perf_hooks';
import { parseInput, validateSamples } from './config.js';
import { createExtractor, memoryFootprint, percentile, scoreSignal, trainModel } from './detector.js';
import { rms } from './real-detector.js';

const N = 512;
const BANDS = 16;
let hann;
function getHann() {
  hann ??= Float64Array.from({ length: N }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)));
  return hann;
}

export function fft(real, imaginary) {
  const n = real.length;
  if (n < 2 || (n & (n - 1)) || imaginary.length !== n) throw new Error('FFT requires equal power-of-two arrays.');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= n; length *= 2) {
    for (let start = 0; start < n; start += length) {
      for (let j = 0; j < length / 2; j++) {
        const angle = -2 * Math.PI * j / length;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const a = start + j;
        const b = a + length / 2;
        const re = real[b] * c - imaginary[b] * s;
        const im = real[b] * s + imaginary[b] * c;
        real[b] = real[a] - re;
        imaginary[b] = imaginary[a] - im;
        real[a] += re;
        imaginary[a] += im;
      }
    }
  }
}

export function shapeFeatures(signal, amplitude = false) {
  validateSamples(signal);
  const mean = signal.reduce((sum, v) => sum + v, 0) / N;
  let square = 0;
  for (const x of signal) square += (x - mean) ** 2;
  const scale = Math.sqrt(square / N);
  if (scale < 1e-12) throw new Error('Invalid sensor window: centered RMS is below 1e-12; no normal fallback.');
  const real = new Float64Array(N);
  const imaginary = new Float64Array(N);
  let fourth = 0;
  let crest = 0;
  let crossings = 0;
  for (let i = 0; i < N; i++) {
    const value = (signal[i] - mean) / scale;
    fourth += value ** 4;
    crest = Math.max(crest, Math.abs(value));
    if (i && (signal[i] >= mean) !== (signal[i - 1] >= mean)) crossings++;
    real[i] = value * getHann()[i];
  }
  fft(real, imaginary);
  const energies = new Float64Array(BANDS);
  let total = 0;
  for (let bin = 1; bin <= N / 2; bin++) {
    const power = real[bin] ** 2 + imaginary[bin] ** 2;
    energies[Math.floor((bin - 1) / 16)] += power;
    total += power;
  }
  if (!(total > 0)) throw new Error('Invalid zero-energy spectrum.');
  const features = new Float64Array(amplitude ? 20 : 19);
  for (let b = 0; b < BANDS; b++) features[b] = Math.log((energies[b] / total + 1e-12) / (1 + BANDS * 1e-12));
  features[16] = Math.log(fourth / N);
  features[17] = Math.log(crest);
  features[18] = crossings / (N - 1);
  if (amplitude) features[19] = Math.log(scale);
  return features;
}

export function distance(a, bank, offset = 0) {
  let sum = 0;
  for (let d = 0; d < a.length; d++) sum += (a[d] - bank[offset + d]) ** 2;
  return Math.sqrt(sum / a.length);
}

function standardize(model, features) {
  for (let d = 0; d < features.length; d++) features[d] = (features[d] - model.centers[d]) / model.scales[d];
  return features;
}

export function referenceIndices(rows, count) {
  if (count < 1 || count > rows.length) throw new RangeError('Reference count must fit training rows.');
  const dimension = rows[0].length;
  const center = new Float64Array(dimension);
  let first = 0;
  for (let i = 1; i < rows.length; i++) if (distance(rows[i], center) < distance(rows[first], center)) first = i;
  const selected = [first];
  const nearest = Float64Array.from(rows, (row) => distance(row, rows[first]));
  while (selected.length < count) {
    let next = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!selected.includes(i) && (next === -1 || nearest[i] > nearest[next])) next = i;
    }
    selected.push(next);
    for (let i = 0; i < rows.length; i++) nearest[i] = Math.min(nearest[i], distance(rows[i], rows[next]));
  }
  return selected;
}

export function quantizeModel(model) {
  if (model.precision !== 'float64') throw new Error('Only a Float64 model can be quantized.');
  const { dimension, bankSize } = model;
  const quantScale = new Float64Array(dimension);
  for (let d = 0; d < dimension; d++) {
    let peak = 0;
    for (let i = 0; i < bankSize; i++) peak = Math.max(peak, Math.abs(model.bank[i * dimension + d]));
    quantScale[d] = peak === 0 ? 1 : peak / 127;
  }
  const bank = Int8Array.from(model.bank, (v, i) => Math.max(-127, Math.min(127, Math.round(v / quantScale[i % dimension]))));
  const radii = new Float64Array(bankSize);
  for (let b = 0; b < bankSize; b++) {
    let error = 0;
    for (let d = 0; d < dimension; d++) {
      const index = b * dimension + d;
      error += (model.bank[index] - bank[index] * quantScale[d]) ** 2;
    }
    radii[b] = Math.sqrt(error / dimension) + 1e-12;
  }
  return {
    id: `${model.id}-int8`, family: model.family, precision: 'int8-certified',
    dimension, bankSize, centers: model.centers.slice(), scales: model.scales.slice(),
    threshold: model.threshold, calibrationByRecording: structuredClone(model.calibrationByRecording),
    bank, quantScale, radii,
  };
}

export function referenceInterval(model, query) {
  let estimate = Infinity;
  let lower = Infinity;
  let upper = Infinity;
  for (let b = 0; b < model.bankSize; b++) {
    let sum = 0;
    for (let d = 0; d < model.dimension; d++) {
      sum += (query[d] - model.bank[b * model.dimension + d] * model.quantScale[d]) ** 2;
    }
    const dist = Math.sqrt(sum / model.dimension);
    // Covers floating arithmetic in the bound calculation; this is not directed-rounding formal verification.
    const tolerance = 1e-10 * (1 + dist);
    estimate = Math.min(estimate, dist);
    lower = Math.min(lower, Math.max(0, dist - model.radii[b] - tolerance));
    upper = Math.min(upper, dist + model.radii[b] + tolerance);
  }
  return { score: estimate, lower, upper };
}

export function scoreResearch(model, signal) {
  let interval;
  if (model.family === 'rms') {
    const score = rms(signal);
    interval = { score, lower: score, upper: score };
  } else if (model.family === 'legacy') {
    const score = scoreSignal(model.legacy, signal).score;
    interval = { score, lower: score, upper: score };
  } else {
    const features = standardize(model, shapeFeatures(signal, model.family === 'hybrid'));
    if (model.precision === 'int8-certified') interval = referenceInterval(model, features);
    else {
      let score = Infinity;
      for (let b = 0; b < model.bankSize; b++) score = Math.min(score, distance(features, model.bank, b * model.dimension));
      interval = { score, lower: score, upper: score };
    }
  }
  if (![interval.score, interval.lower, interval.upper].every(Number.isFinite)) throw new Error('Nonfinite research score.');
  return {
    ...interval, threshold: model.threshold,
    decision: interval.lower > model.threshold ? 'anomaly' : interval.upper <= model.threshold ? 'normal' : 'abstain',
    scope: model.precision === 'int8-certified' ? 'Quantization consistency with the matched Float64 reference, not correctness of the fault label.' : 'CPU baseline',
  };
}

export function trainResearch(candidate, fit, calibration) {
  if (!fit.length || calibration.length !== 2 || fit.some((r) => r.kind !== 'normal')
      || calibration.some((r) => r.kind !== 'normal')) throw new Error('Only healthy fit and two independent normal calibration recordings are allowed.');
  if (candidate.precision === 'int8-certified') throw new Error('Quantize a matched calibrated Float64 model instead.');
  const signals = fit.flatMap((r) => r.windows.map((w) => w.samples));
  const model = { id: candidate.id, family: candidate.family, precision: 'float64', threshold: 0 };
  if (model.family === 'legacy') {
    model.legacy = trainModel('compact', signals, calibration.flatMap((r) => r.windows.map((w) => w.samples)), { sampleRateHz: 4000 });
  } else if (model.family !== 'rms') {
    const raw = signals.map((s) => shapeFeatures(s, model.family === 'hybrid'));
    model.dimension = raw[0].length;
    model.bankSize = candidate.bankSize;
    model.centers = new Float64Array(model.dimension);
    model.scales = new Float64Array(model.dimension);
    for (let d = 0; d < model.dimension; d++) {
      const values = raw.map((row) => row[d]);
      const center = percentile(values, 0.5);
      model.centers[d] = center;
      model.scales[d] = Math.max(0.05, 1.4826 * percentile(values.map((v) => Math.abs(v - center)), 0.5));
    }
    const scaled = raw.map((row) => standardize(model, row));
    const indices = referenceIndices(scaled, model.bankSize);
    model.bank = new Float64Array(model.bankSize * model.dimension);
    indices.forEach((index, i) => model.bank.set(scaled[index], i * model.dimension));
  }
  model.calibrationByRecording = calibration.map((recording) => ({
    name: recording.name, count: recording.windows.length,
    threshold: percentile(recording.windows.map((w) => scoreResearch(model, w.samples).score), 0.95),
  }));
  model.threshold = Math.max(...model.calibrationByRecording.map((g) => g.threshold));
  return model;
}

export function researchMemory(model) {
  if (model.family === 'rms') {
    return { bankBytes: 0, persistentNumericBytes: 8, scratchBytes: 0, inputBytes: 4096, totalNumericBytes: 4104 };
  }
  if (model.family === 'legacy') {
    const memory = memoryFootprint(model.legacy);
    return {
      bankBytes: model.legacy.bank.byteLength, persistentNumericBytes: memory.persistentModelBytes + 8,
      inputBytes: memory.inputBytes, scratchBytes: memory.scratchBytes,
      totalNumericBytes: memory.totalInferenceBytes + 8,
    };
  }
  const persistentNumericBytes = model.centers.byteLength + model.scales.byteLength + model.bank.byteLength
    + (model.quantScale?.byteLength ?? 0) + (model.radii?.byteLength ?? 0) + N * 8 + 8;
  const scratchBytes = N * 8 * 2 + BANDS * 8 + model.dimension * 8;
  return {
    bankBytes: model.bank.byteLength, persistentNumericBytes, scratchBytes, inputBytes: N * 8,
    totalNumericBytes: persistentNumericBytes + scratchBytes + N * 8,
    excludes: 'JS scalar/object overhead, parsed JSON arrays/strings, allocator/GC and Node; numeric scalar threshold counted as 8 bytes. FFT scratch conservatively co-live. Not RAM/peak RSS.',
  };
}

export function runResearch(model, json) {
  const start = performance.now();
  const signal = parseInput(JSON.parse(json), 4000);
  const result = scoreResearch(model, signal);
  JSON.stringify(result);
  return { result, pipelineMs: performance.now() - start };
}

export function encodeModel(model) {
  if (model.family === 'legacy') {
    const m = model.legacy;
    return {
      ...model, legacy: {
        configId: m.configId, sampleRateHz: m.sampleRateHz, dimension: m.dimension, bankSize: m.bankSize,
        threshold: m.threshold, means: Array.from(m.means), scales: Array.from(m.scales), bank: Array.from(m.bank),
      },
    };
  }
  return Object.fromEntries(Object.entries(model).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Array.from(value) : value]));
}

export function decodeModel(object) {
  const model = { ...object };
  if (model.family === 'legacy') {
    const m = model.legacy;
    model.legacy = { ...m, extractor: createExtractor('compact', 4000), means: Float64Array.from(m.means), scales: Float64Array.from(m.scales), bank: Float64Array.from(m.bank) };
  } else if (model.family !== 'rms') {
    model.centers = Float64Array.from(model.centers);
    model.scales = Float64Array.from(model.scales);
    model.bank = model.precision === 'int8-certified' ? Int8Array.from(model.bank) : Float64Array.from(model.bank);
    if (model.quantScale) model.quantScale = Float64Array.from(model.quantScale);
    if (model.radii) model.radii = Float64Array.from(model.radii);
  }
  return model;
}
