import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { getEnvironmentConfig } from "./config.ts";
import type { PaneInspection } from "./lifecycle.ts";
import type { TerminalBackend } from "./terminal.ts";

const execFileAsync = promisify(execFile);

type CoreTerminal = {
  address: string;
  state: "live" | "finished";
  status?: { state?: string; app?: string };
};

function parseTerminal(output: string, address?: string): CoreTerminal {
  const record = JSON.parse(output);
  if (
    typeof record?.address !== "string" || !record.address ||
    (address && record.address !== address) ||
    (record.state !== "live" && record.state !== "finished")
  ) {
    throw new Error("herdr-core returned an invalid terminal record");
  }
  return record;
}

function isCoreError(error: unknown, kind: string): boolean {
  const failure = error as { stdout?: unknown; stderr?: unknown };
  for (const output of [failure?.stderr, failure?.stdout]) {
    if (typeof output !== "string") continue;
    try {
      if (JSON.parse(output)?.error?.kind === kind) return true;
    } catch {}
  }
  return false;
}

export function createCoreBackend(): TerminalBackend {
  let executable: string | undefined;
  for (const candidate of ["hc", "herdr-core"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      executable = candidate;
      break;
    } catch {}
  }
  const permitted = Boolean(process.env.HC_TERMINAL_ID) || getEnvironmentConfig().allowOutsideHerdr;
  const parent = process.env.HC_TERMINAL_ID;
  const run = (args: string[]): string => {
    if (!executable) throw new Error("Neither hc nor herdr-core is available");
    return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  const runAsync = async (args: string[]): Promise<string> => {
    if (!executable) throw new Error("Neither hc nor herdr-core is available");
    const { stdout } = await execFileAsync(executable, args, { encoding: "utf8" });
    return stdout;
  };
  const labelParent = (key: string, value: string): void => {
    if (parent) run(["label", parent, `${key}=${value}`]);
  };

  return Object.freeze({
    kind: "herdr-core",
    isAvailable() {
      if (!executable || !permitted) return false;
      try {
        run(["ls", "--json"]);
        return true;
      } catch {
        return false;
      }
    },
    async launch(request) {
      const output = run([
        "run", "--json", "--bg", "--no-notify", "--no-parent", "--outlive-parent", "--cwd", request.cwd,
        "--label", `name=${request.name}`, "--label", `task=${request.task}`,
        "bash", request.scriptPath,
      ]);
      return parseTerminal(output).address;
    },
    send(address, command) {
      run(["send", address, command]);
    },
    interrupt(address) {
      run(["keys", address, "esc"]);
    },
    read(address, lines) {
      return run(["read", address, "--lines", String(lines)]);
    },
    readAsync(address, lines) {
      return runAsync(["read", address, "--lines", String(lines)]);
    },
    async inspect(address): Promise<PaneInspection> {
      try {
        const record = parseTerminal(await runAsync(["get", address, "--json"]), address);
        const raw = record.status?.state;
        const agentStatus = record.state === "finished" ? "unknown"
          : raw === "idle" || raw === "working" || raw === "blocked" || raw === "done" ? raw
          : "unknown";
        return {
          kind: "present",
          observedAt: Date.now(),
          agentStatus,
          ended: record.state === "finished",
          ...(typeof record.status?.app === "string" ? { agent: record.status.app } : {}),
        };
      } catch (error) {
        if (isCoreError(error, "not_found")) return { kind: "missing" };
        return { kind: "unavailable", error: error instanceof Error ? error.message : String(error) };
      }
    },
    close(address) {
      let record: CoreTerminal;
      try {
        record = parseTerminal(run(["get", address, "--json"]), address);
      } catch (error) {
        if (isCoreError(error, "not_found")) return;
        throw error;
      }
      if (record.state === "live") {
        try {
          run(["kill", address]);
        } catch (error) {
          if (isCoreError(error, "not_found")) return;
          if (!isCoreError(error, "finished")) throw error;
        }
      }
      try {
        run(["rm", address]);
      } catch (error) {
        if (!isCoreError(error, "not_found")) throw error;
      }
    },
    setTask(address, task) {
      try {
        run(["label", address, `task=${task}`]);
      } catch {}
    },
    renameTab(title) {
      labelParent("tab", title);
    },
    renameWorkspace(title) {
      labelParent("workspace", title);
    },
  } satisfies TerminalBackend);
}
