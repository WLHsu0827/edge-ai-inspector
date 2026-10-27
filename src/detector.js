import { performance } from 'node:perf_hooks';
import { getConfig, integer, parseInput, SAMPLE_RATE_HZ, validateSamples, WINDOW_SAMPLES } from './config.js';

export function percentile(values, fraction) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) {
    throw new RangeError('Percentiles require finite, nonempty observations.');
  }
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError('Percentile fraction must be between 0 and 1.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function createExtractor(configId, sampleRateHz = SAMPLE_RATE_HZ) {
  integer(sampleRateHz, 'sampleRateHz', 1, 384000);
  const config = getConfig(configId);
  const bins = Array.from({ length: WINDOW_SAMPLES / 2 / config.binStep },
    (_, i) => (i + 1) * config.binStep);
  const coefficients = Float64Array.from(bins, (bin) => 2 * Math.cos(2 * Math.PI * bin / WINDOW_SAMPLES));
  const windowWeights = Float64Array.from({ length: WINDOW_SAMPLES },
    (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW_SAMPLES - 1)));
  const windowSum = windowWeights.reduce((sum, value) => sum + value, 0);
  const featureNames = ['mean', 'rms', 'delta-rms', 'crest-factor', 'kurtosis', 'zero-crossing-rate',
    ...bins.map((bin) => `log-power-${bin * sampleRateHz / WINDOW_SAMPLES}Hz`)];

  function extract(signal) {
    validateSamples(signal);
    let sum = 0;
    let squares = 0;
    let fourth = 0;
    let deltaSquares = 0;
    let peak = 0;
    let crossings = 0;
    for (let i = 0; i < signal.length; i++) {
      const x = signal[i];
      sum += x;
      squares += x * x;
      fourth += x ** 4;
      peak = Math.max(peak, Math.abs(x));
      if (i > 0) {
        deltaSquares += (x - signal[i - 1]) ** 2;
        if ((x >= 0) !== (signal[i - 1] >= 0)) crossings++;
      }
    }
    const rms = Math.sqrt(squares / signal.length);
    const features = new Float64Array(featureNames.length);
    features[0] = sum / signal.length;
    features[1] = rms;
    features[2] = Math.sqrt(deltaSquares / (signal.length - 1));
    features[3] = rms === 0 ? 0 : peak / rms;
    features[4] = squares === 0 ? 0 : fourth / signal.length / (squares / signal.length) ** 2;
    features[5] = crossings / (signal.length - 1);
    // Streaming Goertzel avoids allocating a full complex spectrum for each window.
    for (let b = 0; b < bins.length; b++) {
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < signal.length; i++) {
        const s0 = signal[i] * windowWeights[i] + coefficients[b] * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = Math.max(0, s1 * s1 + s2 * s2 - coefficients[b] * s1 * s2);
      features[6 + b] = Math.log1p(100 * 4 * power / windowSum ** 2);
    }
    return features;
  }
  return { extract, featureNames, coefficients, windowWeights };
}

export function trainModel(configId, fitSignals, calibrationSignals, { sampleRateHz = SAMPLE_RATE_HZ } = {}) {
  const config = getConfig(configId);
  if (!Array.isArray(fitSignals) || fitSignals.length < config.bankSize) {
    throw new RangeError(`Fitting ${configId} requires at least ${config.bankSize} normal windows.`);
  }
  if (!Array.isArray(calibrationSignals) || calibrationSignals.length < 20) {
    throw new RangeError('Calibration requires at least 20 independent normal windows.');
  }
  const extractor = createExtractor(configId, sampleRateHz);
  const fittedFeatures = fitSignals.map(extractor.extract);
  const dimension = extractor.featureNames.length;
  const means = new Float64Array(dimension);
  const scales = new Float64Array(dimension);
  for (let d = 0; d < dimension; d++) {
    means[d] = fittedFeatures.reduce((sum, row) => sum + row[d], 0) / fittedFeatures.length;
    const variance = fittedFeatures.reduce((sum, row) => sum + (row[d] - means[d]) ** 2, 0)
      / fittedFeatures.length;
    // A fixed floor avoids amplifying almost-silent spectral bins or constant features.
    scales[d] = Math.max(0.02, Math.sqrt(variance));
  }
  const bank = new Float64Array(config.bankSize * dimension);
  for (let b = 0; b < config.bankSize; b++) {
    const row = fittedFeatures[Math.floor(b * (fittedFeatures.length - 1) / (config.bankSize - 1))];
    for (let d = 0; d < dimension; d++) bank[b * dimension + d] = (row[d] - means[d]) / scales[d];
  }
  const model = {
    configId, sampleRateHz, extractor, means, scales, bank, dimension, bankSize: config.bankSize,
    threshold: null,
  };
  model.threshold = percentile(calibrationSignals.map((signal) => scoreSignal(model, signal).score), 0.95);
  return model;
}

export function scoreSignal(model, signal) {
  const features = model.extractor.extract(signal);
  for (let d = 0; d < model.dimension; d++) features[d] = (features[d] - model.means[d]) / model.scales[d];
  let score = Infinity;
  let nearest = -1;
  for (let b = 0; b < model.bankSize; b++) {
    let distance = 0;
    for (let d = 0; d < model.dimension; d++) distance += (features[d] - model.bank[b * model.dimension + d]) ** 2;
    distance /= model.dimension;
    if (distance < score) {
      score = distance;
      nearest = b;
    }
  }
  const deviations = Array.from(features, (value, d) => ({
    feature: model.extractor.featureNames[d],
    squaredStandardizedDeviation: (value - model.bank[nearest * model.dimension + d]) ** 2,
  })).sort((a, b) => b.squaredStandardizedDeviation - a.squaredStandardizedDeviation).slice(0, 3);
  return {
    score, threshold: model.threshold,
    isAnomaly: model.threshold === null ? null : score > model.threshold,
    nearestNormalExample: nearest, largestDeviations: deviations,
  };
}

export function memoryFootprint(model) {
  const persistentModelBytes = [
    model.means, model.scales, model.bank,
    model.extractor.coefficients, model.extractor.windowWeights,
  ].reduce((sum, array) => sum + array.byteLength, 0);
  const inputBytes = WINDOW_SAMPLES * Float64Array.BYTES_PER_ELEMENT;
  const scratchBytes = model.dimension * Float64Array.BYTES_PER_ELEMENT;
  return {
    persistentModelBytes, inputBytes, scratchBytes,
    totalInferenceBytes: persistentModelBytes + inputBytes + scratchBytes,
    excludes: 'JS objects, JSON strings/arrays, HTTP buffers, V8/Node, allocator/GC overhead, training and dataset storage.',
  };
}

export function runPipeline(model, inputJson) {
  const start = performance.now();
  const input = parseInput(JSON.parse(inputJson), model.sampleRateHz);
  const inferenceStart = performance.now();
  const result = scoreSignal(model, input);
  const inferenceMs = performance.now() - inferenceStart;
  const outputJson = JSON.stringify(result);
  const requestPipelineMs = performance.now() - start;
  return { result, outputJson, inferenceMs, requestPipelineMs };
}
