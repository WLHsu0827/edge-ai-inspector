import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractScalar } from './uored-scalar-kernel-r3.js';
import { commission, config, decide, referenceHash } from './uored-structure-core.js';
import { PREFIX_SAMPLES, RAW_START, RAW_WINDOW } from './uored-commissioning.js';
import { finitePrefixNoiseRms } from './uored-multiband-input.js';

function options(argv) {
  const mode = argv[0];
  const allowed = mode === 'synthetic' ? ['--output'] : mode === 'files' ?
    ['--healthy', '--query', '--device-id', '--health-confirmed', '--output'] : null;
  if (!allowed) throw new Error('Use synthetic [--output PATH], or files --healthy PREFIX --query RECORDING --device-id ID --health-confirmed [--output PATH].');
  const parsed = new Map();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag) || parsed.has(flag)) {
      throw new RangeError(`Unsupported or repeated CLI option: ${flag}`);
    }
    if (flag === '--health-confirmed') {
      parsed.set(flag, true);
    } else {
      const value = argv[++i];
      if (typeof value !== 'string' || value.startsWith('--') || !value.trim()) {
        throw new RangeError(`Missing value for ${flag}`);
      }
      parsed.set(flag, value);
    }
  }
  if (mode === 'files' &&
      ['--healthy', '--query', '--device-id', '--health-confirmed'].some(
        (key) => !parsed.has(key))) {
    throw new RangeError('File mode requires both recordings, device ID and explicit healthy assertion.');
  }
  return { mode, parsed };
}

function readSamples(path, length) {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  if (lines.length !== length) throw new RangeError(`Expected exactly ${length} samples in ${path}`);
  return Float64Array.from(lines, (line) => {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(line.trim())) {
      throw new RangeError('Only finite decimal numbers, one per line, are accepted.');
    }
    const n = Number(line);
    if (!Number.isFinite(n)) throw new RangeError('Nonfinite input.');
    return n;
  });
}

const { mode, parsed } = options(process.argv.slice(2));
let prefix, query, scope, name, firstScoredFrame;
if (mode === 'synthetic') {
  const signal = (i) => Math.sin(i * .77) + .3 * Math.sin(i * 1.23);
  prefix = Float64Array.from({ length: PREFIX_SAMPLES }, (_, i) => signal(i));
  query = Float64Array.from({ length: RAW_START + 77 * RAW_WINDOW }, (_, i) =>
    signal(i) + (i >= RAW_START + 45 * RAW_WINDOW ? 2 * Math.sin(i * 1.9) : 0));
  name = 'synthetic-demo';
  scope = 'SYNTHETIC same-record-prefix example; query frames 0..31 intentionally excluded, not physical-bearing evidence';
  firstScoredFrame = 32;
} else {
  prefix = readSamples(parsed.get('--healthy'), PREFIX_SAMPLES);
  query = readSamples(parsed.get('--query'), RAW_START + 77 * RAW_WINDOW);
  name = parsed.get('--device-id');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new RangeError('Explicit device ID required.');
  scope = 'Independent query recording; all 77 query frames scored; healthy assertion and sensor configuration not independently verified';
  firstScoredFrame = 0;
}
const noiseRms = finitePrefixNoiseRms(prefix);
const features = (params) => extractScalar(prefix, { count: 32, ...params }).features;
const reference = commission({ healthConfirmed: true, methodId: 'matched-scalar',
  installationConfig: config(name, 1), clean: features({}),
  white: features({ noiseRms, recording: name, phase: 'commission' }),
  colored: features({ noiseRms, recording: name, phase: 'commission-colored' }) });
const all = extractScalar(query, { count: 77 }).features;
const decisions = all.slice(firstScoredFrame).map((feature, i) => ({
  frame: i + firstScoredFrame,
  ...decide(reference, { feature, installationConfig: reference.config }),
}));
const output = {
  scope, method: 'matched-scalar', declaredGain: 1,
  queryRelationship: mode === 'synthetic' ?
    'synthetic same-record healthy-prefix example' : 'independent query recording',
  scoredFrameStart: firstScoredFrame, scoredFrameEndInclusive: 76,
  excludedQueryFrames: firstScoredFrame, queryFrames: decisions.length,
  referenceSha256: referenceHash(reference), referenceThreshold: reference.threshold,
  healthyPrefixFrames: 32,
  querySignalSha256: createHash('sha256').update(Buffer.from(query.buffer)).digest('hex'),
  counts: { anomaly: decisions.filter((d) => d.decision === 'anomaly').length,
    normal: decisions.filter((d) => d.decision === 'normal').length,
    abstain: decisions.filter((d) => d.decision === 'abstain').length },
  decisions,
};
if (parsed.has('--output')) {
  writeFileSync(parsed.get('--output'), `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
}
console.log(JSON.stringify(output));
