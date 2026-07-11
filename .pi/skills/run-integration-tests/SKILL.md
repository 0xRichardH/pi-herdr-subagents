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

From the repository root:

```bash
npm run test:integration
```

The harness loads the extension directly from the working tree and creates isolated test agents. Report passing, failing, and skipped tests. Do not claim full verification when herdr-dependent tests were skipped.
