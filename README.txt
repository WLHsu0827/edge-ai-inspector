PRIVATE r3 CPU source candidate | author review only | 26 Oct 2026

Requires Node.js >=24. No npm install, raw MAT, model weights or network.
From this ZIP's extracted root:
  node src\uored-scalar-demo-r3.js synthetic
  node --test test\uored-scalar-r3.test.js

For predictable resource use, you may add
  --single-threaded --v8-pool-size=1
immediately after node. The test creates/removes its own synthetic text
files; no publisher signal is required.

Optional independent query text-file mode (one finite decimal per line):
  node src\uored-scalar-demo-r3.js files --healthy healthy-prefix.txt --query query.txt --device-id UNIT --health-confirmed --output result.json
The healthy file has 172532 samples (500 warmup + 32 x 5376).
The independent query has 414452 samples (500 warmup + 77 x 5376).
ALL 77 query frames are scored. Only synthetic mode explicitly represents
a single recording with a healthy prefix and excludes frames 0..31, scoring
frames 32..76. Output names the relationship and scored/excluded frames.
Unknown, missing and duplicate CLI options fail; gain is fixed at declared
gain=1, not configurable here. Output file creation is exclusive.
Health and sensor/gain configuration are operator assertions, not verified
device authentication; do not assert health for an arbitrary faulty prefix.

ScalarStream is a one-shot open -> finished or failed API. Any failed push
or finish permanently invalidates that instance; a second finish or a
post-finish push throws. Each new stream uses frozen filters and normalized
three-band scalar power, but omits unused A/B envelope/periodicity. For
extreme finite input, error behavior of the unused generic features can
still differ. Exact parity on already-viewed development data does not
turn this into a new H17/H18 validation.

r3 source parity/benchmark runners and their saved outputs are included
for traceability, but the raw publisher development MAT files are NOT in
this ZIP. Running those research runners requires separately authorized
exact publisher data at the original private plan destination and a
matching frozen project environment; the portable no-data demo/tests above
are independently executable. No H17/H18 scores were recomputed with r3.

Source MIT. UORED: Mert Sehri, Patrick Dumond, Michel Bouchard,
Mendeley Data v5 doi:10.17632/y2px5tg92h.5 (CC BY 4.0), data paper
doi:10.1016/j.dib.2023.109327. Ottawa manifest metadata is included
only for the existing source module import chain: Huang & Baddour,
doi:10.17632/v43hmbwxpm.1 (CC BY 4.0). No dataset, weights,
credentials, personal/ID data or private key files bundled. AI tools
assisted coding and drafting; publication/rights/organizer rules and
owner signature/submission remain unresolved.
