// Draws docs/architecture.svg. Run: node docs/draw-architecture.js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const W = 1030, H = 520;
const FONT = 'Segoe UI, Helvetica, Arial, sans-serif';
const INK = '#1d2b36', MUTED = '#4f6070', LINE = '#3d5566';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Conservative width estimate so long lines fail here instead of spilling out of a box.
const textWidth = (s, size, bold) => [...s].length * size * (bold ? 0.6 : 0.55);

const parts = [];
function box({ x, y, w, h, title, lines, fill, stroke }) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
  const rows = [[title, 15, true], ...lines.map((l) => [l, 13, false])];
  let ty = y + 26;
  for (const [text, size, bold] of rows) {
    if (textWidth(text, size, bold) > w - 16) throw new Error(`Text too wide for box: ${text}`);
    parts.push(`<text x="${x + w / 2}" y="${ty}" font-size="${size}"${bold ? ' font-weight="600"' : ''} fill="${bold ? INK : MUTED}" text-anchor="middle">${esc(text)}</text>`);
    ty += bold ? 24 : 19;
  }
  if (ty - 19 > y + h - 8) throw new Error(`Text too tall for box: ${title}`);
}
function arrow(points, label, labelAt) {
  const d = points.map(([px, py], i) => `${i ? 'L' : 'M'}${px} ${py}`).join(' ');
  parts.push(`<path d="${d}" fill="none" stroke="${LINE}" stroke-width="1.8" marker-end="url(#head)"/>`);
  if (label) {
    const [lx, ly, anchor = 'middle'] = labelAt;
    parts.push(`<text x="${lx}" y="${ly}" font-size="13" font-style="italic" fill="${INK}" text-anchor="${anchor}">${esc(label)}</text>`);
  }
}
function heading(x, y, text) {
  parts.push(`<text x="${x}" y="${y}" font-size="14" font-weight="600" fill="${MUTED}" letter-spacing="0.5">${esc(text)}</text>`);
}

const RUN = { fill: '#eef5fb', stroke: '#6f97b8' };
const IO = { fill: '#fff6e5', stroke: '#c99a3c' };
const SETUP = { fill: '#eef7ee', stroke: '#6fa36f' };

// Monitoring path, one column per stage.
const top = 50, th = 170, cw = 162, gap = 38, x0 = 20;
const col = (i) => x0 + i * (cw + gap);
heading(x0, 32, 'MONITORING: every 128 ms frame');
box({ x: col(0), y: top, w: cw, h: th, title: 'Input', ...IO,
  lines: ['vibration from one', 'accelerometer', '42,000 samples/s'] });
box({ x: col(1), y: top, w: cw, h: th, title: 'Band-pass ×3', ...RUN,
  lines: ['2–5, 5–10 and', '10–15 kHz;', '4th-order', 'Butterworth'] });
box({ x: col(2), y: top, w: cw, h: th, title: 'Frame energy', ...RUN,
  lines: ['Σ y² over 5,376', 'samples per band,', '÷ filter noise gain', 'S = P₁ + P₂ + P₃'] });
box({ x: col(3), y: top, w: cw, h: th, title: 'Score', ...RUN,
  lines: ['x = log(S / scale)', 'd = min |x − bᵢ|', 'over the 8 healthy', 'references bᵢ'] });
box({ x: col(4), y: top, w: 200, h: th, title: 'Output decision', ...IO,
  lines: ['anomaly if d > T', 'normal if d ≤ T', 'abstain if S is unusable', 'requires-reference', 'requires-recalibration'] });
const mid = top + 62;
const signals = ['x[n]', 'y₁₋₃', 'S', 'd'];
signals.forEach((s, i) => arrow([[col(i) + cw, mid], [col(i + 1) - 2, mid]], s, [col(i) + cw + gap / 2, mid - 10]));

// Commissioning path.
const low = 330, lh = 150;
heading(x0, low - 18, 'COMMISSIONING: once per installation, about 4.1 s of healthy vibration');
box({ x: col(0), y: low, w: cw + 50, h: lh, title: 'Healthy recording', ...SETUP,
  lines: ['32 frames, confirmed', 'healthy by a technician;', 'same filters → S₀ … S₃₁'] });
box({ x: col(1) + 90, y: low, w: 230, h: lh, title: 'Fit: frames 0–15', ...SETUP,
  lines: ['scale = median of S₀ … S₁₅', 'bᵢ = log(Sₖ / scale) at the', '8 even frames k = 0 … 14'] });
box({ x: col(3) - 20, y: low, w: 190, h: lh, title: 'Calibrate: 16–31', ...SETUP,
  lines: ['d under clean, white', 'and AR(1) noise (20 dB)', 'p95 per condition'] });
box({ x: col(4) + 10, y: low, w: 190, h: lh, title: 'Reference', ...SETUP,
  lines: ['T = 1.10 × max p95', 'declared device, sensor,', 'gain, rate; ≤ 30 days', 'SHA-256 of the record'] });
const lmid = low + 60;
arrow([[col(0) + cw + 50, lmid], [col(1) + 88, lmid]], 'S', [col(0) + cw + 70, lmid - 10]);
arrow([[col(1) + 320, lmid], [col(3) - 22, lmid]], 'bᵢ, scale', [col(1) + 325, lmid - 10, 'start']);
arrow([[col(3) + 170, lmid], [col(4) + 8, lmid]], 'p95', [col(3) + 190, lmid - 10]);
const fitX = col(1) + 90 + 115, bend = top + th + 55;
arrow([[fitX, low], [fitX, bend], [col(3) + 50, bend], [col(3) + 50, top + th + 2]], 'scale, bᵢ', [fitX + 12, bend - 8, 'start']);
arrow([[col(4) + 105, low], [col(4) + 105, top + th + 2]], 'T, config', [col(4) + 113, low - 40, 'start']);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-labelledby="title desc">
<title id="title">Edge AI Inspector signal path</title>
<desc id="desc">Vibration samples pass through three band-pass filters, are reduced to one energy value S per 128 ms frame, scored as the distance d from eight healthy references, and compared with a calibrated threshold T. A one-time commissioning step on about 4.1 seconds of healthy vibration sets the scale, the references and T.</desc>
<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${LINE}"/></marker></defs>
<rect width="${W}" height="${H}" fill="#ffffff"/>
${parts.join('\n')}
<text x="${W - 20}" y="${H - 14}" font-size="12" fill="${MUTED}" text-anchor="end">Drawn by docs/draw-architecture.js</text>
</svg>
`;
writeFileSync(fileURLToPath(new URL('./architecture.svg', import.meta.url)), svg);
console.log(`architecture.svg: ${Buffer.byteLength(svg)} B`);
