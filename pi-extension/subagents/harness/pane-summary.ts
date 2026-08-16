import type { SubagentResultContext } from "./types.ts";

export function extractPaneSummary(context: SubagentResultContext, displayName: string): string {
  const { completionResult, surface, readPane } = context;
  const summary = readPane(surface, 200)
    .replace(/__SUBAGENT_DONE_\d+__/, "")
    .trimEnd();

  if (summary) return summary;

  return completionResult.exitCode !== 0
    ? `${displayName} exited with code ${completionResult.exitCode}`
    : `${displayName} exited without output`;
}
