# Full suite

- Date: 2026-11-21 (Asia/Bangkok).
- Result: PASS.
- Totals: 67 tests; 67 pass; 0 fail; 0 cancelled; 0 skipped; 0 todo.
- Command: `taskpolicy -b nice -n 19 env NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 npm test`.
- Runner: `node --test --test-concurrency=1 --test-timeout=30000 tests/*.test.js`.
- Source identity: extension/package `0.2.5`; no Git metadata/revision available. Shared MCP broker/client modules, per-request GPT tabs/workers, durable request digests and filename reservations, controller ownership/readiness, preserved manual permission handling, existing GPT wait and Tripo price fixes.
- Working-tree state: current unpacked source and version 0.2.5 release changes; bundled helper download and package-derived MCP version included. No runtime dependency or marketplace submission changes.
- Test/config identity: current `package.json`; all nine `tests/*.test.js` files; Node built-in runner, no external dependencies. All required automated tests executed.
- Reuse: no durable revision identity. Compare relevant source/tests/dependencies/configuration; version alone insufficient.
