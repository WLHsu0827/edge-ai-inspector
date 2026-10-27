import { performance } from 'node:perf_hooks';
import { biquad } from './uored-envelope-dsp.js';
import { BANDS, FILTER_GAINS, inject } from './uored-structure-dsp.js';
import { RAW_START, RAW_WINDOW, PREFIX_WINDOWS, TOTAL_WINDOWS } from './uored-commissioning.js';

const Q = [0.541196100146197, 1.306562964876377];

// The per-section update and band accumulation order match the frozen extractor.
export class ScalarStream {
  #state = 'open';

  constructor(count) {
    if (![PREFIX_WINDOWS, TOTAL_WINDOWS].includes(count)) {
      throw new RangeError('Exact 32/77 frame count required.');
    }
    this.count = count;
    this.at = 0;
    this.filters = BANDS.map(([lo, hi]) =>
      [...Q.map((q) => biquad('high', lo, q)),
        ...Q.map((q) => biquad('low', hi, q))]);
    this.power = Array.from({ length: count }, () => [0, 0, 0]);
  }

  push(chunk) {
    if (this.#state !== 'open') throw new Error(`Scalar stream is ${this.#state}.`);
    try {
      if (!(chunk instanceof Float64Array) ||
          this.at + chunk.length > RAW_START + RAW_WINDOW * this.count) {
        throw new RangeError('Invalid or excess scalar stream input.');
      }
      for (const sample of chunk) {
        const i = this.at;
        if (!Number.isFinite(sample)) throw new RangeError(`Nonfinite sample at ${i}`);
        for (let band = 0; band < BANDS.length; band++) {
          let value = sample;
          for (const filter of this.filters[band]) {
            const y = filter.b0 * value + filter.z1;
            const z1 = filter.b1 * value - filter.a1 * y + filter.z2;
            const z2 = filter.b2 * value - filter.a2 * y;
            if (![y, z1, z2].every(Number.isFinite)) {
              throw new RangeError(`Filter overflow at ${i}`);
            }
            filter.z1 = z1;
            filter.z2 = z2;
            value = y;
          }
          const square = value * value;
          if (!Number.isFinite(square)) throw new RangeError(`Square overflow at ${i}`);
          if (i >= RAW_START) {
            const frame = Math.floor((i - RAW_START) / RAW_WINDOW);
            this.power[frame][band] += square;
            if (!Number.isFinite(this.power[frame][band])) {
              throw new RangeError(`Energy overflow at ${i}`);
            }
          }
        }
        this.at++;
      }
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
  }

  finish() {
    if (this.#state !== 'open') throw new Error(`Scalar stream is ${this.#state}.`);
    try {
      if (this.at !== RAW_START + RAW_WINDOW * this.count) {
        throw new RangeError('Incomplete scalar stream; missing frames.');
      }
      const power = this.power.map((values) => values.map((value, band) => {
        const normalized = value / (RAW_WINDOW * FILTER_GAINS[band]);
        if (!Number.isFinite(normalized)) throw new RangeError('Nonfinite normalized band energy.');
        return normalized;
      }));
      const features = power.map((values) => {
        const sum = values.reduce((a, b) => a + b, 0);
        if (values.some((v) => !Number.isFinite(v) || v < 0) ||
            !Number.isFinite(sum)) throw new RangeError('Invalid band powers.');
        return sum >= 1e-24 && values.some((v) => v >= 1e-24) ? [sum] : null;
      });
      this.#state = 'finished';
      return { features, power, stateNumericBytes:
        this.filters.length * 4 * 7 * 8 + this.power.length * 3 * 8 };
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
  }
}

export function scalarFromStressed(stressed, count, chunkSize = 8191) {
  if (!(stressed instanceof Float64Array) ||
      stressed.length !== RAW_START + RAW_WINDOW * count ||
      !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError('Exact aligned stressed input and positive chunk size required.');
  }
  const stream = new ScalarStream(count);
  for (let start = 0; start < stressed.length; start += chunkSize) {
    stream.push(stressed.subarray(start, Math.min(start + chunkSize, stressed.length)));
  }
  return stream.finish();
}

export function extractScalar(raw, { count, gain = 1, noiseRms = 0,
  recording = '', phase = 'query', chunkSize = 8191 }) {
  if (!(raw instanceof Float64Array) ||
      ![PREFIX_WINDOWS, TOTAL_WINDOWS].includes(count) ||
      raw.length !== RAW_START + RAW_WINDOW * count) {
    throw new RangeError('Exact aligned 32/77 frame raw input required.');
  }
  const start = performance.now();
  const stressed = inject(raw, { gain, noiseRms, recording, phase });
  const stressMs = performance.now() - start;
  const prep = performance.now();
  const result = scalarFromStressed(stressed, count, chunkSize);
  return { ...result, stressMs, scalarMs: performance.now() - prep };
}
