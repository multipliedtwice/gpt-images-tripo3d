# Full suite

- Date: 2026-11-22 (Asia/Bangkok).
- Result: PASS.
- Totals: 74 tests; 74 pass; 0 fail; 0 cancelled; 0 skipped; 0 todo.
- Command: `taskpolicy -b nice -n 19 env NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 npm test`.
- Runner: `node --test --test-concurrency=1 --test-timeout=30000 tests/*.test.js`.
- Source identity: extension/package `0.2.6`; Git initialized, no HEAD revision. Current source includes request-scoped GPT workers and destination-validated readiness during loading; pending navigation must commit before inspection.
- Working-tree state: initial source staged; release version changes in `manifest.json`, `package.json`, `dashboard.html`, `store/listing.json`; matching bundled helper rebuilt. Readiness changes and regression tests included. No runtime dependency or test-runner changes.
- Test/config identity: current `package.json`; all nine `tests/*.test.js` files; Node built-in runner, no external dependencies. All required automated tests executed.
- Reuse: no durable revision identity. Compare relevant source/tests/dependencies/configuration; version alone insufficient.
