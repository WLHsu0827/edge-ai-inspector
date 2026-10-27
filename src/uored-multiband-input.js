import { PREFIX_SAMPLES, RAW_START } from './uored-commissioning.js';

// Preserve the existing prefix-only arithmetic order; reject nonfinite intermediates.
export function finitePrefixNoiseRms(prefix, gain = 1) {
  if (!(prefix instanceof Float64Array) || prefix.length !== PREFIX_SAMPLES ||
      ![0.5, 1, 2].includes(gain)) throw new RangeError('Aligned healthy prefix required.');
  for (let i = 0; i < RAW_START; i++) {
    if (!Number.isFinite(prefix[i])) throw new RangeError('Nonfinite prefix warmup.');
  }
  let sum = 0;
  for (let i = RAW_START; i < prefix.length; i++) {
    if (!Number.isFinite(prefix[i])) throw new RangeError('Nonfinite healthy prefix.');
    sum += prefix[i];
    if (!Number.isFinite(sum)) throw new RangeError('Prefix mean overflow.');
  }
  const slice = prefix.subarray(RAW_START);
  const mean = sum / slice.length;
  let squared = 0;
  for (const value of slice) {
    const term = (value - mean) ** 2;
    if (!Number.isFinite(term)) throw new RangeError('Prefix AC square overflow.');
    squared += term;
    if (!Number.isFinite(squared)) throw new RangeError('Prefix AC accumulation overflow.');
  }
  const rms = Math.sqrt(squared / slice.length) * gain;
  if (!(Number.isFinite(rms) && rms >= 1e-12)) {
    throw new RangeError('Invalid/zero healthy-prefix AC power.');
  }
  return rms / 10;
}
