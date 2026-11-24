# Full suite

- Date: 2026-11-24 (Asia/Bangkok).
- Result: PASS.
- Totals: 99 tests; 99 pass; 0 fail; 0 cancelled; 0 skipped; 0 todo.
- Command: `taskpolicy -b nice -n 19 env NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 npm test`.
- Runner: `node --test --test-concurrency=1 --test-timeout=30000 tests/*.test.js`.
- Source identity: extension/package `0.2.8`; HEAD `1c5c246`.
- Working-tree state: changes in `content.js`, `dashboard.js`, `tests/tripo-content.test.js`, `manifest.json`, `package.json`, `dashboard.html`, `store/listing.json`. Unavailable-model detection and explicit retry revalidation. Release version updated; dependencies and test runner configuration unchanged.
- Test/config identity: current `package.json`; all nine `tests/*.test.js` files; Node built-in runner, no external dependencies. All required automated tests executed.
- Reuse: no durable revision identity. Compare relevant source/tests/dependencies/configuration; version alone insufficient.
