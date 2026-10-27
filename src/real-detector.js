import { performance } from 'node:perf_hooks';
import { parseInput, validateSamples, WINDOW_SAMPLES } from './config.js';
import { memoryFootprint, percentile, scoreSignal, trainModel } from './detector.js';
import { manifest, REAL_IDS, splitWindows } from './real-data.js';

export function rms(signal) {
  validateSamples(signal);
  let squares = 0;
  for (const value of signal) squares += value * value;
  return Math.sqrt(squares / signal.length);
}

export function trainReal(configId, data) {
  if (!REAL_IDS.includes(configId)) throw new RangeError('Unknown real-data detector.');
  const splits = splitWindows(data);
  const calibration = splits.calibration.map((r) => r.signal);
  if (configId === 'rms') {
    return {
      configId, sampleRateHz: manifest.protocol.sampleRateHz,
      parameters: Float64Array.of(percentile(calibration.map(rms), 0.95)),
    };
  }
  return trainModel(configId, splits.fit.map((r) => r.signal), calibration, { sampleRateHz: manifest.protocol.sampleRateHz });
}

export function scoreReal(model, signal) {
  if (model.configId !== 'rms') return scoreSignal(model, signal);
  const score = rms(signal);
  return { score, threshold: model.parameters[0], isAnomaly: score > model.parameters[0], largestDeviations: [] };
}

export function realMemory(model) {
  if (model.configId !== 'rms') return memoryFootprint(model);
  return {
    persistentModelBytes: model.parameters.byteLength, inputBytes: WINDOW_SAMPLES * 8, scratchBytes: 0,
    totalInferenceBytes: model.parameters.byteLength + WINDOW_SAMPLES * 8,
    excludes: 'JS scalars/objects, JSON/HTTP, Node/V8/GC, training, FIR and datasets. This is NOT process RAM.',
  };
}

export function runRealPipeline(model, text) {
  const started = performance.now();
  const input = parseInput(JSON.parse(text), model.sampleRateHz);
  const inferenceStart = performance.now();
  const result = scoreReal(model, input);
  const inferenceMs = performance.now() - inferenceStart;
  const outputJson = JSON.stringify(result);
  return { result, outputJson, inferenceMs, requestPipelineMs: performance.now() - started };
}
