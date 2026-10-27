export const SAMPLE_RATE_HZ = 2048;
export const WINDOW_SAMPLES = 512;
export const DEFAULT_SEED = 42;
export const PROTOCOL = 'synthetic-vibration-v1';
export const CONFIGS = Object.freeze([
  Object.freeze({ id: 'compact', binStep: 16, bankSize: 8 }),
  Object.freeze({ id: 'balanced', binStep: 8, bankSize: 32 }),
  Object.freeze({ id: 'detailed', binStep: 4, bankSize: 128 }),
]);

export function getConfig(id) {
  const config = CONFIGS.find((entry) => entry.id === id);
  if (!config) throw new RangeError(`Unknown configuration: ${String(id)}`);
  return config;
}

export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function validateSamples(samples) {
  if (!(Array.isArray(samples) || samples instanceof Float64Array)
      || samples.length !== WINDOW_SAMPLES) {
    throw new RangeError(`samples must contain exactly ${WINDOW_SAMPLES} numbers.`);
  }
  for (const value of samples) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000) {
      throw new RangeError('Every sample must be a finite number between -1000 and 1000.');
    }
  }
  return samples;
}

export function parseInput(input, expectedSampleRateHz = SAMPLE_RATE_HZ) {
  integer(expectedSampleRateHz, 'expectedSampleRateHz', 1, 384000);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Input must be an object with sampleRateHz and samples.');
  }
  if (Object.keys(input).some((key) => !['sampleRateHz', 'samples'].includes(key))) {
    throw new TypeError('Input only accepts sampleRateHz and samples; labels are not inference inputs.');
  }
  if (input.sampleRateHz !== expectedSampleRateHz) {
    throw new RangeError(`sampleRateHz must be ${expectedSampleRateHz}; inference does not resample inputs.`);
  }
  return Float64Array.from(validateSamples(input.samples));
}

export function signalInput(signal, sampleRateHz = SAMPLE_RATE_HZ) {
  return { sampleRateHz, samples: Array.from(signal) };
}
