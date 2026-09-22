/**
 * Project-trust resolution for spawned pi children (B12).
 *
 * A one-shot child launched into a folder with project-local pi resources
 * (`.pi/settings.json`, `.pi/skills`, ...) falls through pi's project-trust
 * resolution to an interactive selector when there is no `--approve` /
 * `--no-approve` override, no extension decision and no trust-store entry.
 * A non-interactive child can never answer that selector, so the lane hangs at
 * startup having done zero work. Every pi child therefore carries one explicit
 * trust flag.
 *
 * The resolution mirrors pi's own order (dist/core/trust-manager.js): the
 * nearest-ancestor decision in `<agentDir>/trust.json`, with the parent's own
 * decision inherited when the child runs in the parent's folder. When nothing
 * decides, we do NOT silently grant trust - we pass `--no-approve`, which is
 * pi's own no-UI default, so the hang is removed without escalating privilege.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SpawnTrustFlag = "--approve" | "--no-approve";

/** Pi's canonicalizePath: realpath, falling back to the resolved path. */
function canonicalizePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Pi's agent config dir resolution (PI_CODING_AGENT_DIR, else ~/.pi/agent). */
export function resolveTrustStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "trust.json");
}

/**
 * Mirrors pi's findNearestTrustEntry: walk childCwd upward until an ancestor
 * has a true/false decision. Missing, unreadable or malformed stores and
 * non-boolean values yield "no decision" - never a throw.
 */
export function readNearestTrustDecision(
  store: Record<string, unknown> | null,
  childCwd: string,
): boolean | undefined {
  if (!store) return undefined;
  let current = canonicalizePath(childCwd);
  for (;;) {
    const value = store[current];
    if (value === true) return true;
    if (value === false) return false;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readTrustStore(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface SpawnTrustInput {
  /** Effective cwd the child will run in. */
  childCwd: string;
  /** Parent session cwd, when known. */
  parentCwd?: string;
  /** Parent's own project-trust decision, when known. */
  parentTrusted?: boolean;
  /** Override for tests; defaults to resolveTrustStorePath(). */
  trustStorePath?: string;
}

/**
 * Pure trust-flag resolution:
 * (a) child in the parent's own folder -> inherit the parent's decision;
 * (b) nearest-ancestor decision recorded in pi's trust store;
 * (c) no decision -> --no-approve (pi's no-UI default, never a silent grant).
 */
export function resolveSpawnTrustFlag(input: SpawnTrustInput): SpawnTrustFlag {
  // (a) Same folder as the parent: inherit the parent's decision. Only when
  // the parent's decision is actually known; otherwise fall through.
  if (
    input.parentCwd !== undefined &&
    input.parentTrusted !== undefined &&
    canonicalizePath(input.childCwd) === canonicalizePath(input.parentCwd)
  ) {
    return input.parentTrusted ? "--approve" : "--no-approve";
  }

  // (b) Nearest-ancestor decision from the trust store.
  const store = readTrustStore(input.trustStorePath ?? resolveTrustStorePath());
  const decision = readNearestTrustDecision(store, input.childCwd);
  if (decision === true) return "--approve";
  if (decision === false) return "--no-approve";

  // (c) No decision anywhere.
  return "--no-approve";
}
