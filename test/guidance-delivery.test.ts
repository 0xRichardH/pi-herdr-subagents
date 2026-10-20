import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureGuidanceRequests } from "./guidance-session.ts";

describe("provider-bound subagent guidance", () => {
  it("delivers both catalogs on repeated requests without duplication", async () => {
    const requests = await captureGuidanceRequests({ requests: 2 });
    for (const { prompt, tools } of requests) {
      assert.ok(tools.includes("subagent"));
      assert.ok(prompt.includes("Available named subagents"), "provider instructions must contain the named-agent catalog");
      assert.ok(prompt.includes("Authenticated subagent models"), "provider instructions must contain the authenticated model catalog");
      assert.equal(prompt.split("Available named subagents").length - 1, 1);
      assert.equal(prompt.split("Authenticated subagent models").length - 1, 1);
      assert.match(prompt, /researcher.*Researches external topics using authoritative sources/);
      assert.match(prompt, /^- guidance-test\/fast /m);
      assert.match(prompt, /^- guidance-test\/research /m);
      assert.doesNotMatch(prompt, /becomes available after session start|PRIVATE_AGENT_DESCRIPTION|private-agent/);
    }
  });

  it("delivers initialized catalogs when the session has a nonempty scope", async () => {
    const [{ prompt }] = await captureGuidanceRequests({ scoped: true });
    assert.match(prompt, /^- guidance-test\/fast /m);
    assert.match(prompt, /Available named subagents/);
    assert.doesNotMatch(prompt, /becomes available after session start/);
  });

  it("refreshes the delivered named-agent catalog after reload without duplication", async () => {
    const [before, after] = await captureGuidanceRequests({ requests: 2, reloadBetweenRequests: true });
    assert.match(before.prompt, /Researches external topics using authoritative sources/);
    assert.match(after.prompt, /REFRESHED_RESEARCHER_DESCRIPTION/);
    assert.doesNotMatch(after.prompt, /Researches external topics using authoritative sources/);
    for (const { prompt } of [before, after]) {
      assert.equal(prompt.split("Available named subagents").length - 1, 1);
      assert.equal(prompt.split("Authenticated subagent models").length - 1, 1);
    }
  });

  for (const mode of ["denied", "inactive", "hidden"] as const) {
    it(`does not leak catalogs when the subagent tool is ${mode}`, async () => {
      const [{ prompt, tools }] = await captureGuidanceRequests({ [mode]: true });
      assert.ok(!tools.includes("subagent"));
      assert.doesNotMatch(prompt, /Available named subagents|Authenticated subagent models|Researches external topics|guidance-test\/research/);
    });
  }

  it("retains earlier and later extensions' guideline contributions", async () => {
    const requests = await captureGuidanceRequests({ contributions: true, requests: 2 });
    for (const { prompt } of requests) {
      for (const text of ["EARLIER_SUBAGENT_GUIDELINE", "LATER_SUBAGENT_GUIDELINE", "OTHER_GLOBAL_GUIDELINE"]) {
        assert.equal(prompt.split(text).length - 1, 1);
      }
      assert.match(prompt, /Authenticated subagent models/);
      assert.match(prompt, /Available named subagents/);
    }
  });
});
