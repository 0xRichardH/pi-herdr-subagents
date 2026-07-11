/**
 * Integration tests for herdr terminal operations.
 *
 * These tests exercise real herdr operations: creating panes,
 * sending commands, reading output, preserving focus, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run `npm run test:integration` from inside herdr.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  getFocusedSurface,
  untrackSurface,
  runInPane,
  runScriptInPane,
  readPane,
  readPaneAsync,
  closePane,
  interruptPane,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
const FOCUS_TEST_SHELL_READY_DELAY_MS = Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "2500");

if (backends.length === 0) {
  console.log("⚠️  herdr is unavailable — skipping terminal integration tests");
  console.log("   Run inside herdr to enable these tests.");
}

for (const backend of backends) {
  describe(`herdr terminal [${backend}]`, { timeout: 60_000 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    it("keeps focus on the current pane while creating and targeting subagent tabs", async () => {
      const focusedPane = getFocusedSurface(backend);
      assert.ok(focusedPane, "Expected herdr to report the currently focused pane");

      const childA = createTrackedSurface(env, "focus-child-a");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(backend), focusedPane);

      const childB = createTrackedSurface(env, "focus-child-b");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(backend), focusedPane);

      const markerA = uniqueId();
      const markerB = uniqueId();
      runInPane(childA, `echo "FOCUS_A_${markerA}"`);
      runInPane(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(backend), focusedPane);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      runInPane(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readPane(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closePane(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      runInPane(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readPane(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      runScriptInPane(surface, command);
      await sleep(2000);

      const screen = readPane(surface, 50);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      runInPane(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readPaneAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      runInPane(s1, `echo "S1_${m1}"`);
      runInPane(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readPane(s1, 50);
      const screen2 = readPane(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-mux-test-${marker}.txt`;

      runInPane(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });

    it("delivers Escape as byte 27 to the target surface", async () => {
      const surface = createTrackedSurface(env, "escape-byte-test");
      await sleep(1000);

      const marker = uniqueId();
      const byteFile = `/tmp/pi-mux-escape-${marker}.txt`;
      trackTempFile(env, byteFile);

      const nodeProgram =
        "const fs = require('node:fs');" +
        "if (!process.stdin.isTTY) throw new Error('stdin is not a TTY');" +
        "process.stdin.setRawMode(true);" +
        "process.stdin.resume();" +
        "process.stdout.write('ESC_READY\\n');" +
        "process.stdin.once('data', (chunk) => {" +
        `fs.writeFileSync(${JSON.stringify(byteFile)}, Array.from(chunk).join(','));` +
        "process.exit(0);" +
        "});";
      const command = `node -e ${JSON.stringify(nodeProgram)}`;

      runScriptInPane(surface, command);
      await waitForScreen(surface, /ESC_READY/, 15_000, 50);

      interruptPane(surface);

      const content = await waitForFile(byteFile, 15_000, /^27$/);
      assert.equal(content.trim(), "27");
    });
  });
}
