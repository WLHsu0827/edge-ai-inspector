import { inflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { biquad } from './uored-envelope-dsp.js';
import { random } from './data.js';
import { RAW_START, RAW_WINDOW, PREFIX_WINDOWS, TOTAL_WINDOWS }
  from './uored-commissioning.js';

const Q = [0.541196100146197, 1.306562964876377];
const SOURCE_SAMPLES = 420000;

function tag(bytes, at) {
  if (at + 8 > bytes.length) throw new Error('Truncated MAT tag.');
  const word = bytes.readUInt32LE(at);
  const small = word >>> 16;
  if (small > 4) throw new Error('Unsupported MAT inline tag.');
  const type = small ? word & 0xffff : word;
  const length = small || bytes.readUInt32LE(at + 4);
  const start = at + (small ? 4 : 8);
  if (start + length > bytes.length) throw new Error('Truncated MAT payload.');
  let next = small ? at + 8 : start + Math.ceil(length / 8) * 8;
  if (type === 15 && !small) {
    const end = start + length;
    next = next <= bytes.length && bytes.subarray(end, next).every((value) => value === 0) ? next : end;
  }
  return { type, data: bytes.subarray(start, start + length), next };
}

// Fork of the frozen MAT first-column decoder: only the unproven abs<=1000
// domain restriction is removed. No scaling, clipping or column substitution.
export function readFiniteAcceleration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 128 ||
      !bytes.toString('ascii', 0, 19).startsWith('MATLAB 5.0 MAT-file') ||
      bytes.toString('ascii', 126, 128) !== 'IM') {
    throw new Error('Expected little-endian MATLAB v5; HDF5/v7.3 and big-endian require review.');
  }
  let selected;
  function matrix(buffer) {
    const flags = tag(buffer, 0);
    const dims = tag(buffer, flags.next);
    if (flags.type !== 6 || flags.data.length !== 8 || flags.data.readUInt32LE(0) & 0x800 ||
        dims.type !== 5 || dims.data.length !== 8) throw new Error('Expected real, 2D MATLAB numeric matrix.');
    const rows = dims.data.readInt32LE(0), cols = dims.data.readInt32LE(4);
    const name = tag(buffer, dims.next);
    if (![1, 2, 16].includes(name.type)) throw new Error('Invalid MATLAB variable name.');
    if (rows !== SOURCE_SAMPLES || cols !== 5) return;
    if (selected) throw new Error('Ambiguous multiple 420000 x 5 MATLAB matrices.');
    const values = tag(buffer, name.next);
    const width = values.type === 9 ? 8 : values.type === 7 ? 4 : null;
    if (!width || values.data.length !== rows * cols * width) throw new Error('Unsupported/malformed 420000 x 5 numeric matrix.');
    selected = { variable: name.data.toString('utf8'), samples: new Float64Array(rows) };
    for (let i = 0; i < rows; i++) {
      const value = width === 8 ? values.data.readDoubleLE(i * width) : values.data.readFloatLE(i * width);
      if (!Number.isFinite(value)) throw new Error('Nonfinite accelerometer value.');
      selected.samples[i] = value;
    }
  }
  function walk(buffer, from, compressedAllowed) {
    for (let pos = from; pos < buffer.length;) {
      const item = tag(buffer, pos);
      if (item.type === 15 && compressedAllowed) {
        walk(inflateSync(item.data, { maxOutputLength: 24 * 1024 * 1024 }), 0, false);
      } else if (item.type === 14) matrix(item.data);
      else throw new Error(`Unsupported MATLAB element ${item.type}.`);
      pos = item.next;
    }
  }
  walk(bytes, 128, true);
  if (!selected) throw new Error('No unique real 420000 x 5 matrix.');
  return selected;
}

function seedFor(recording, phase) {
  let seed = phase === 'commission' ? 20261027 : 20261026;
  for (const c of `${recording}:${phase}`) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  return seed;
}

// Fork of the frozen band-RMS filter with the same coefficients, windowing,
// gain, seed and operations. Every nonfinite intermediate fails closed.
export function finiteBandRms(raw, { count, gain = 1, noiseRms = 0, recording = '', phase = 'query' }) {
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
    if (!Number.isFinite(original)) throw new RangeError(`Nonfinite 42kHz sample at ${i}; no normal fallback.`);
    let value = original * gain;
    if (!Number.isFinite(value)) throw new RangeError(`Gain overflow at ${i}.`);
    if (rng) {
      const injected = noiseRms * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      if (!Number.isFinite(injected)) throw new RangeError(`Noise overflow at ${i}.`);
      value += injected;
      if (!Number.isFinite(value)) throw new RangeError(`Input addition overflow at ${i}.`);
    }
    for (const s of sections) {
      const y = s.b0 * value + s.z1;
      const z1 = s.b1 * value - s.a1 * y + s.z2;
      const z2 = s.b2 * value - s.a2 * y;
      if (![y, z1, z2].every(Number.isFinite)) {
        throw new RangeError(`Filter overflow at ${i}.`);
      }
      s.z1 = z1;
      s.z2 = z2;
      value = y;
    }
    if (i >= RAW_START) {
      const square = value * value;
      if (!Number.isFinite(square)) throw new RangeError(`Square overflow at ${i}.`);
      sumSquares += square;
      if (!Number.isFinite(sumSquares)) throw new RangeError(`Accumulation overflow at ${i}.`);
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
