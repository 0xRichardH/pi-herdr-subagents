import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionDelivery } from "../pi-extension/subagents/completion-delivery.ts";

test("completion during invalidated reload waits for rebind and delivers exactly once", async () => {
  let invalid = false;
  const messages: string[] = [];
  const old = { sendMessage() { assert.equal(invalid, false, "old API is stale"); } };
  const delivery = new CompletionDelivery<typeof old>();
  delivery.bind(old);
  delivery.detach(true);
  invalid = true;
  assert.throws(() => old.sendMessage(), /old API is stale/); // deterministic negative control
  let state = "pending";
  const result = delivery.enqueue((api) => {
    assert.equal(state, "pending");
    api.sendMessage();
    state = "delivered";
  });
  await Promise.resolve();
  assert.equal(state, "pending");
  assert.deepEqual(messages, []);
  const fresh = { sendMessage() { messages.push("completion"); } };
  delivery.bind(fresh);
  await result;
  delivery.bind(fresh);
  delivery.detach(true);
  delivery.bind(fresh);
  assert.equal(state, "delivered");
  assert.deepEqual(messages, ["completion"]);
});

test("terminal teardown suppresses queued and late completions", async () => {
  const delivery = new CompletionDelivery<object>();
  const queued = delivery.enqueue(() => assert.fail("queued terminal delivery"));
  delivery.detach(false);
  await queued;
  await delivery.enqueue(() => assert.fail("late terminal delivery"));
  delivery.bind({});
});

test("a reentrant reload stops draining until next bind", async () => {
  const delivery = new CompletionDelivery<{ version: number }>();
  const received: number[] = [];
  const first = delivery.enqueue(api => { received.push(api.version); delivery.detach(true); });
  const second = delivery.enqueue(api => { received.push(api.version); });
  delivery.bind({ version: 1 });
  await first;
  assert.deepEqual(received, [1]);
  delivery.bind({ version: 2 });
  await second;
  assert.deepEqual(received, [1, 2]);
});
