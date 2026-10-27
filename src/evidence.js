import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import os from 'node:os';
import { CONFIGS, PROTOCOL } from './config.js';
import { DEFAULT_BUDGETS, selectConfiguration } from './metrics.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const file of ['config.js', 'data.js', 'detector.js', 'metrics.js', 'benchmark-worker.js', 'benchmark.js', 'evidence.js']) {
    hash.update(file).update(readFileSync(join(ROOT, 'src', file)));
  }
  return hash.digest('hex');
}

export function loadEvidence(path = join(ROOT, 'results', 'benchmark.json')) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { report: null, error: 'No benchmark report yet. Run npm.cmd run benchmark, then restart the demo.' };
    }
    throw error;
  }
  const report = JSON.parse(text);
  if (report?.schemaVersion !== 1 || report.protocol !== PROTOCOL || report.sourceFingerprint !== sourceFingerprint()
      || report.runtime?.node !== process.version || report.runtime.platform !== process.platform
      || report.runtime.arch !== process.arch || report.runtime.osRelease !== os.release()
      || report.runtime.cpuModel !== (os.cpus()[0]?.model ?? 'Unavailable')
      || report.results?.length !== CONFIGS.length
      || !CONFIGS.every((c) => report.results.some((r) => r.configId === c.id))) {
    return { report: null, error: 'Benchmark evidence is stale or incompatible. Run npm.cmd run benchmark, then restart the demo.' };
  }
  selectConfiguration(report.results, DEFAULT_BUDGETS);
  return { report, error: null };
}
