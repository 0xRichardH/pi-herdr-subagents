---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

Run this workflow from inside herdr. This project supports no other terminal backend.

## Preflight

```bash
echo "HERDR_ENV=$HERDR_ENV"
command -v herdr
npm test
```

Stop and ask the user to start pi inside herdr if `HERDR_ENV` is not `1` or the CLI is missing.

## Integration suite

From the repository root, run the suite with the project's reliable test model:

```bash
PI_TEST_MODEL="deepseek/deepseek-v4-flash" PI_TEST_TIMEOUT=180000 npm run test:integration
```

The full suite launches real Pi sessions and can take several minutes. `PI_TEST_TIMEOUT` is the per-test timeout in milliseconds; use at least `180000` for the lifecycle suite.

The harness loads the extension directly from the working tree and creates isolated test agents. `PI_TEST_MODEL` controls every real Pi/LLM session in the lifecycle suite; use `deepseek/deepseek-v4-flash` instead of the slower, less predictable `openrouter/free` default. Report passing, failing, and skipped tests. Do not claim full verification when herdr-dependent tests were skipped.
