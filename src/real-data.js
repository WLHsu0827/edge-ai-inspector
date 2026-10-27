import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integer, validateSamples, WINDOW_SAMPLES } from './config.js';
import { ROOT } from './evidence.js';

export const REAL_IDS = Object.freeze(['rms', 'compact', 'balanced', 'detailed']);
export const REAL_NOTICE = 'REAL LAB RECORDINGS - recording/speed holdout, NOT independent-device or industrial validation.';
export const MANIFEST_PATH = join(ROOT, 'datasets', 'ottawa-subset.json');
export const PREPARED_PATH = join(ROOT, 'data', 'ottawa', 'prepared.json');
export const REAL_REPORT_PATH = join(ROOT, 'results', 'real-benchmark.json');
export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

export function realFingerprint() {
  const hash = createHash('sha256');
  for (const name of [
    'config.js', 'detector.js', 'metrics.js', 'data.js', 'mat.js', 'real-data.js',
    'prepare-real.js', 'real-detector.js', 'real-benchmark.js', 'real-worker.js',
  ]) {
    hash.update(name).update(readFileSync(join(ROOT, 'src', name)));
  }
  hash.update(readFileSync(MANIFEST_PATH));
  return hash.digest('hex');
}

export function validateGroups(files) {
  const seenIds = new Set();
  const seenHashes = new Set();
  for (const file of files) {
    if (!['fit', 'calibration', 'validation', 'test'].includes(file.split)
        || !['normal', 'inner-race', 'outer-race'].includes(file.kind)) {
      throw new Error('Unknown split or health label.');
    }
    if (seenIds.has(file.name) || seenHashes.has(file.sha256)) throw new Error('Duplicate recording/hash across groups.');
    seenIds.add(file.name);
    seenHashes.add(file.sha256);
    if (['fit', 'calibration'].includes(file.split) && file.kind !== 'normal') {
      throw new Error('Fit and calibration must contain only normal recordings.');
    }
    if ((file.split === 'test') !== (file.profile === 'C')) throw new Error('Profile C must be reserved for the final test.');
  }
  for (const split of ['fit', 'calibration', 'validation', 'test']) {
    const group = files.filter((file) => file.split === split);
    if (!group.length || !group.some((file) => file.kind === 'normal')) throw new Error(`Missing normal recordings in ${split}.`);
    if (['validation', 'test'].includes(split)
        && !['inner-race', 'outer-race'].every((kind) => group.some((file) => file.kind === kind))) {
      throw new Error(`Missing fault class in ${split}.`);
    }
  }
}

export function lowPassKernel(taps, sampleRateHz, cutoffHz) {
  integer(taps, 'filter taps', 3, 10001);
  if (taps % 2 === 0 || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0
      || !Number.isFinite(cutoffHz) || cutoffHz <= 0 || cutoffHz >= sampleRateHz / 2) {
    throw new RangeError('Low-pass requires odd taps and cutoff below Nyquist.');
  }
  const kernel = new Float64Array(taps);
  const center = (taps - 1) / 2;
  for (let k = 0; k < taps; k++) {
    const d = k - center;
    const sinc = d === 0 ? 2 * cutoffHz / sampleRateHz
      : Math.sin(2 * Math.PI * cutoffHz / sampleRateHz * d) / (Math.PI * d);
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * k / (taps - 1))
      + 0.08 * Math.cos(4 * Math.PI * k / (taps - 1));
    kernel[k] = sinc * window;
  }
  const sum = kernel.reduce((a, b) => a + b, 0);
  return kernel.map((v) => v / sum);
}

export function decimate(signal, factor, kernel) {
  integer(factor, 'decimation factor', 1, 1000);
  if (!(signal instanceof Float64Array) || !(kernel instanceof Float64Array)
      || kernel.length % 2 !== 1 || signal.length < kernel.length) {
    throw new TypeError('Decimation requires a signal and an odd-length FIR kernel.');
  }
  const result = new Float64Array(Math.floor((signal.length - kernel.length) / factor) + 1);
  for (let out = 0; out < result.length; out++) {
    let sum = 0;
    const start = out * factor;
    for (let tap = 0; tap < kernel.length; tap++) sum += signal[start + tap] * kernel[tap];
    result[out] = sum;
  }
  return result;
}

export function windowRecording(signal, file) {
  const windows = [];
  const p = manifest.protocol;
  for (let start = 0; start + WINDOW_SAMPLES <= signal.length; start += WINDOW_SAMPLES) {
    windows.push({
      index: windows.length,
      sourceCenterStart: (p.filterTaps - 1) / 2 + start * p.decimationFactor,
      samples: Array.from(validateSamples(signal.slice(start, start + WINDOW_SAMPLES))),
    });
  }
  return { ...file, windows, usedSamples: windows.length * WINDOW_SAMPLES, discardedTailSamples: signal.length % WINDOW_SAMPLES };
}

export function loadPrepared() {
  let text;
  try {
    text = readFileSync(PREPARED_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Real data are not prepared. Run npm.cmd run data:download, then npm.cmd run data:prepare.');
    throw error;
  }
  const data = JSON.parse(text);
  if (data.protocol !== manifest.protocol.id || data.sourceFingerprint !== realFingerprint()
      || data.manifestSha256 !== sha256(readFileSync(MANIFEST_PATH))) {
    throw new Error('Prepared data are stale; rerun npm.cmd run data:prepare and npm.cmd run benchmark:real.');
  }
  if (data.recordings.length !== manifest.files.length) throw new Error('Prepared recording count mismatch.');
  validateGroups(data.recordings);
  for (const expected of manifest.files) {
    const actual = data.recordings.find((r) => r.name === expected.name);
    if (!actual || ['sha256', 'split', 'kind', 'profile', 'trial'].some((key) => actual[key] !== expected[key])) {
      throw new Error('Prepared data do not match frozen recording assignments.');
    }
    if (actual.windows.length !== 78) throw new Error('Expected 78 nonoverlapping windows per pinned recording.');
    for (let i = 0; i < actual.windows.length; i++) {
      const window = actual.windows[i];
      if (window.index !== i || window.sourceCenterStart !== 500 + i * 512 * 50) throw new Error('Prepared window boundaries changed.');
      validateSamples(window.samples);
    }
  }
  return { ...data, preparedSha256: sha256(text) };
}

export function splitWindows(data) {
  const splits = { fit: [], calibration: [], validation: [], test: [] };
  for (const recording of data.recordings) {
    for (const window of recording.windows) {
      splits[recording.split].push({
        signal: Float64Array.from(window.samples), recording: recording.name,
        index: window.index, kind: recording.kind, anomaly: recording.kind !== 'normal',
      });
    }
  }
  return splits;
}
