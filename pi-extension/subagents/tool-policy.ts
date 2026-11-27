import { readFileSync, writeFileSync } from "node:fs";

const VERSION = 2;

export interface PiToolPolicy {
  denyTools: string[];
  toolAllowlist: string | null;
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes(",");
}

export function piDenyToolsAssignment(
  denyTools: Iterable<string>,
  shellQuote: (value: string) => string,
): string {
  return `PI_DENY_TOOLS=${shellQuote([...denyTools].join(","))}`;
}

export function writePiToolPolicy(sessionPath: string, policy: PiToolPolicy): void {
  const recordPath = `${sessionPath}.tool-policy.json`;
  const body = JSON.stringify({ version: VERSION, sessionPath, ...policy });
  try {
    writeFileSync(recordPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not save the Pi tool policy for ${sessionPath}: ${detail}`);
  }
}

export function readPiToolPolicy(sessionPath: string): PiToolPolicy {
  const recordPath = `${sessionPath}.tool-policy.json`;
  let record: { version?: unknown; sessionPath?: unknown; denyTools?: unknown; toolAllowlist?: unknown } | null;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`No saved tool policy for ${sessionPath}. Spawn a new helper with the intended restrictions.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the Pi tool policy ${recordPath}: ${detail}`);
  }
  const denyTools = record?.denyTools;
  const toolAllowlist = record?.toolAllowlist;
  if (record?.version !== VERSION || record.sessionPath !== sessionPath
    || !Array.isArray(denyTools) || !denyTools.every(validToolName)
    || (toolAllowlist !== null && (typeof toolAllowlist !== "string" || !toolAllowlist.split(",").every(validToolName)))) {
    throw new Error(`Invalid or unsupported Pi tool policy for ${sessionPath}. Spawn a new helper with the intended restrictions.`);
  }
  return { denyTools, toolAllowlist };
}
