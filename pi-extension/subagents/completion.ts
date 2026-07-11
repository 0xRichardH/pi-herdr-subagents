import { existsSync, readFileSync, rmSync } from "node:fs";

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;

export interface CompletionResult {
  reason: "done" | "ping" | "sentinel" | "error";
  exitCode: number;
  ping?: { name: string; message: string };
  errorMessage?: string;
}

export interface CompletionOptions {
  intervalMs: number;
  readTerminalTail: () => Promise<string>;
  sessionFile?: string;
  sentinelFile?: string;
  onTick?: (elapsedSeconds: number) => void;
}

export function interpretExitSidecar(data: unknown): CompletionResult {
  const payload = data as {
    type?: unknown;
    name?: unknown;
    message?: unknown;
    errorMessage?: unknown;
  };

  if (payload?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: {
        name: typeof payload.name === "string" ? payload.name : "subagent",
        message: typeof payload.message === "string" ? payload.message : "",
      },
    };
  }

  if (payload?.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" && payload.errorMessage.trim()
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }

  return { reason: "done", exitCode: 0 };
}

function consumeExitSidecar(sessionFile: string | undefined): CompletionResult | null {
  if (!sessionFile) return null;

  const exitFile = `${sessionFile}.exit`;
  if (!existsSync(exitFile)) return null;

  try {
    const result = interpretExitSidecar(JSON.parse(readFileSync(exitFile, "utf8")));
    rmSync(exitFile, { force: true });
    return result;
  } catch {
    // The child may still be writing the file. Retry on the next polling cycle.
    return null;
  }
}

function terminalExitCode(screen: string): number | null {
  const match = screen.match(TERMINAL_SENTINEL);
  return match ? Number.parseInt(match[1], 10) : null;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(ABORT_MESSAGE));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForCompletion(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionResult> {
  const startedAt = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error(ABORT_MESSAGE);

    const sidecarResult = consumeExitSidecar(options.sessionFile);
    if (sidecarResult) return sidecarResult;

    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    try {
      const exitCode = terminalExitCode(await options.readTerminalTail());
      if (exitCode !== null) return { reason: "sentinel", exitCode };
    } catch {
      // Pane reads can fail transiently while herdr updates or closes a pane.
    }

    options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
    await abortableDelay(options.intervalMs, signal);
  }
}
