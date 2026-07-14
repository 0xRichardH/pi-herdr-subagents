import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release workflow reacts to package version changes and creates all release artifacts", async () => {
  const workflow = await readFile(".github/workflows/publish.yml", "utf8");

  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /paths:\n\s+- package\.json/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /git tag -a "\$TAG"/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /gh release create "\$TAG"/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /npmjs\.com\/package\/pi-herdr-subagents\/v\/\$\{VERSION\}/);
});
