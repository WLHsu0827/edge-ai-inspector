import { createHash } from 'node:crypto';
import { percentile } from './detector.js';
import { validateConfig } from './uored-commissioning.js';

export const ALGORITHM = 'uored-structure-commissioning-development-v1';
export const IDS = Object.freeze(['matched-scalar', 'band-contrast', 'band-contrast-periodicity']);
const FIT = [0, 2, 4, 6, 8, 10, 12, 14];
const AGE = 30 * 86400000;
const TIME = '2026-10-26T00:00:00.000Z';

export function config(unit, gain) {
  return { deviceId: `development-unit-${unit}`, sensorId: `declared-sensor-unit-${unit}`,
    gain, sampleRateHz: 42000, algorithmVersion: ALGORITHM };
}

export function referenceHash(reference) {
  return createHash('sha256').update(JSON.stringify(reference)).digest('hex');
}

function distance(feature, bank, scale, id) {
  if (feature === null) return null;
  if (!Array.isArray(feature) || feature.length !== (id === IDS[0] ? 1 : id === IDS[1] ? 2 : 5) ||
      feature.some((x) => !Number.isFinite(x))) throw new RangeError('Invalid feature shape.');
  const f = id === IDS[0] ? [Math.log(feature[0] / scale)] : feature;
  if (f.some((v) => !Number.isFinite(v))) return null;
  let nearest = Infinity;
  for (const row of bank) {
    let sum = 0;
    for (let k = 0; k < f.length; k++) sum += (f[k] - row[k]) ** 2;
    nearest = Math.min(nearest, Math.sqrt(sum));
  }
  if (!Number.isFinite(nearest)) throw new RangeError('Distance overflow.');
  return nearest;
}

export function commission({ healthConfirmed, methodId, installationConfig,
  clean, white, colored, commissionedAtUtc = TIME }) {
  validateConfig(installationConfig, false);
  if (installationConfig.algorithmVersion !== ALGORITHM ||
      healthConfirmed !== true || !IDS.includes(methodId) ||
      ![clean, white, colored].every((features) =>
        Array.isArray(features) && features.length === 32) ||
      !Number.isFinite(Date.parse(commissionedAtUtc)) ||
      new Date(commissionedAtUtc).toISOString() !== commissionedAtUtc) {
    throw new RangeError('Explicit healthy 32-frame prefix/config and three fixed calibration conditions required.');
  }
  const fitIndices = FIT.filter((n) => clean[n]?.length ===
    (methodId === IDS[0] ? 1 : methodId === IDS[1] ? 2 : 5));
  if (JSON.stringify(fitIndices) !== JSON.stringify(methodId === IDS[2] ? FIT.slice(2) : FIT)) {
    throw new RangeError('Incomplete fixed distinct fit references.');
  }
  const scale = methodId === IDS[0] ?
    percentile(clean.slice(0, 16).map((row) => row?.[0]), .5) : 1;
  if (!(Number.isFinite(scale) && scale > 1e-24)) throw new RangeError('Invalid fit-only scalar scale.');
  const bank = fitIndices.map((n) => methodId === IDS[0] ?
    [Math.log(clean[n][0] / scale)] : [...clean[n]]);
  if (bank.flat().some((x) => !Number.isFinite(x))) throw new RangeError('Invalid fit reference.');
  const calibration = [clean, white, colored].map((set) =>
    set.slice(16, 32).map((feature) => distance(feature, bank, scale, methodId)));
  if (calibration.some((set) => set.some((v) => !(Number.isFinite(v) && v >= 0)))) {
    throw new RangeError('All 16 healthy calibration frames per condition must be valid.');
  }
  const p95 = calibration.map((set) => percentile(set, .95));
  const threshold = 1.1 * Math.max(...p95);
  if (!(threshold > 0 && Number.isFinite(threshold))) throw new RangeError('Invalid healthy calibration threshold.');
  return { schema: ALGORITHM, methodId, config: structuredClone(installationConfig),
    healthAssertion: 'operator-confirmed; not independently proven',
    sourceScope: 'healthy first32: fit0..15, calibration16..31; no tail/fault/auto-update',
    commissionedAtUtc, factor: 1.1, fitIndices, scale, bank, calibration, p95, threshold };
}

export function decide(reference, { feature, installationConfig, atUtc = TIME }) {
  validateConfig(installationConfig, false);
  const now = Date.parse(atUtc);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== atUtc) {
    throw new RangeError('Valid explicit UTC query time required.');
  }
  if (reference == null) return { decision: 'requires-reference' };
  if (reference.schema !== ALGORITHM || !IDS.includes(reference.methodId) ||
      reference.factor !== 1.1 ||
      reference.healthAssertion !== 'operator-confirmed; not independently proven' ||
      reference.sourceScope !== 'healthy first32: fit0..15, calibration16..31; no tail/fault/auto-update' ||
      JSON.stringify(reference.fitIndices) !==
        JSON.stringify(reference.methodId === IDS[2] ? FIT.slice(2) : FIT) ||
      !Array.isArray(reference.bank) || reference.bank.length !== reference.fitIndices.length ||
      reference.bank.some((row) => !Array.isArray(row) ||
        row.length !== (reference.methodId === IDS[0] ? 1 : reference.methodId === IDS[1] ? 2 : 5) ||
        row.some((v) => !Number.isFinite(v))) ||
      !(Number.isFinite(reference.scale) && reference.scale > 0) ||
      !Array.isArray(reference.calibration) || reference.calibration.length !== 3 ||
      reference.calibration.some((set) => !Array.isArray(set) || set.length !== 16 ||
        set.some((v) => !(Number.isFinite(v) && v >= 0))) ||
      !Array.isArray(reference.p95) || reference.p95.length !== 3 ||
      reference.p95.some((v, i) => v !== percentile(reference.calibration[i], .95)) ||
      reference.threshold !== 1.1 * Math.max(...reference.p95) ||
      !(reference.threshold > 0)) throw new RangeError('Tampered/malformed structural reference.');
  validateConfig(reference.config, false);
  if (reference.config.algorithmVersion !== ALGORITHM) throw new RangeError('Wrong reference algorithm.');
  const age = now - Date.parse(reference.commissionedAtUtc);
  if (Object.keys(reference.config).some((key) =>
    reference.config[key] !== installationConfig[key]) || age < 0 || age > AGE) {
    return { decision: 'requires-recalibration' };
  }
  if (feature === null) return { decision: 'abstain', reason: 'warmup-or-invalid-feature' };
  const score = distance(feature, reference.bank, reference.scale, reference.methodId);
  if (score === null) return { decision: 'abstain', reason: 'invalid-feature' };
  return { decision: score > reference.threshold ? 'anomaly' : 'normal',
    score, threshold: reference.threshold, referenceSha256: referenceHash(reference) };
}
