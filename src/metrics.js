import { percentile } from './detector.js';

export function quality(rows) {
  if (!rows.length) throw new RangeError('Quality metrics require observations.');
  const counts = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const byKind = {};
  for (const row of rows) {
    if (typeof row.anomaly !== 'boolean' || typeof row.isAnomaly !== 'boolean' || !Number.isFinite(row.score)) {
      throw new TypeError('Invalid labeled evaluation result.');
    }
    counts[row.anomaly ? (row.isAnomaly ? 'tp' : 'fn') : (row.isAnomaly ? 'fp' : 'tn')]++;
    byKind[row.kind] ??= { total: 0, flagged: 0 };
    byKind[row.kind].total++;
    if (row.isAnomaly) byKind[row.kind].flagged++;
  }
  const { tp, fp, tn, fn } = counts;
  const positives = rows.filter((row) => row.anomaly);
  const negatives = rows.filter((row) => !row.anomaly);
  let wins = 0;
  for (const pos of positives) {
    for (const neg of negatives) wins += pos.score > neg.score ? 1 : pos.score === neg.score ? 0.5 : 0;
  }
  return {
    count: rows.length, ...counts,
    precision: tp + fp === 0 ? 0 : tp / (tp + fp),
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
    f1: 2 * tp + fp + fn === 0 ? 0 : 2 * tp / (2 * tp + fp + fn),
    accuracy: (tp + tn) / rows.length,
    falsePositiveRate: fp + tn === 0 ? null : fp / (fp + tn),
    auroc: positives.length && negatives.length ? wins / (positives.length * negatives.length) : null,
    byKind,
  };
}

export function latencyDistribution(values) {
  return {
    count: values.length, min: percentile(values, 0),
    p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99),
    max: percentile(values, 1), mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

export const DEFAULT_BUDGETS = Object.freeze({
  maxManagedKiB: 32, maxProcessMiB: 256, maxP95Ms: 5,
});

export function validateBudgets(budgets) {
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)
      || Object.keys(budgets).length !== 3
      || Object.keys(budgets).some((key) => !Object.hasOwn(DEFAULT_BUDGETS, key))) {
    throw new TypeError('Supply exactly maxManagedKiB, maxProcessMiB and maxP95Ms.');
  }
  for (const [name, value] of Object.entries(budgets)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a finite nonnegative number.`);
    }
  }
  return budgets;
}

export function selectConfiguration(results, budgets) {
  validateBudgets(budgets);
  if (!Array.isArray(results) || !results.length) throw new RangeError('Selection requires measured configurations.');
  const seen = new Set();
  for (const result of results) {
    if (typeof result.configId !== 'string' || seen.has(result.configId)) {
      throw new TypeError('Measured configuration IDs must be unique strings.');
    }
    seen.add(result.configId);
    const values = [
      result.memory?.managedNumeric?.totalInferenceBytes, result.memory?.processPeakRssBytes,
      result.latency?.requestPipelineMs?.p95, result.quality?.selectionValidation?.f1,
    ];
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        || values[1] === 0 || values[3] > 1) {
      throw new RangeError('Selection requires finite, valid measured memory, p95 and validation F1 values.');
    }
  }
  const decisions = results.map((result) => {
    const rejectedBy = [];
    if (result.memory.managedNumeric.totalInferenceBytes > budgets.maxManagedKiB * 1024) rejectedBy.push('managed numeric buffers');
    if (result.memory.processPeakRssBytes > budgets.maxProcessMiB * 1024 ** 2) rejectedBy.push('process peak RSS');
    if (result.latency.requestPipelineMs.p95 > budgets.maxP95Ms) rejectedBy.push('request pipeline p95');
    return { configId: result.configId, feasible: rejectedBy.length === 0, rejectedBy };
  });
  const eligible = results.filter((result) => decisions.find((d) => d.configId === result.configId).feasible);
  eligible.sort((a, b) => b.quality.selectionValidation.f1 - a.quality.selectionValidation.f1
    || a.memory.managedNumeric.totalInferenceBytes - b.memory.managedNumeric.totalInferenceBytes
    || a.latency.requestPipelineMs.p95 - b.latency.requestPipelineMs.p95);
  return {
    budgets, selectedConfigId: eligible[0]?.configId ?? null, decisions,
    reason: eligible.length ? 'Highest selection-validation F1 among feasible configurations; ties prefer smaller managed buffers, then lower p95.'
      : 'No measured configuration meets all budgets. No fallback was selected.',
    warning: 'Measured eligibility on this CPU, not a hard real-time or whole-machine memory guarantee.',
  };
}
