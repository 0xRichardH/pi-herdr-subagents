import type { SubagentResultContext } from "./types.ts";

/**
 * TASK-337: the synthesized summary for a pane with no substantive content.
 * It stays non-empty so non-zero exits and display still name the absence, but
 * the admission boundary treats this literal as null evidence (see
 * `isPaneAbsenceSummary`) rather than as a terminal report.
 */
export function paneAbsenceSummary(displayName: string, exitCode: number): string {
  return exitCode !== 0
    ? `${displayName} exited with code ${exitCode}`
    : `${displayName} exited without output`;
}

/**
 * TASK-337: true when a driver's extracted summary is only the synthesized
 * absence literal, i.e. the run carried no substantive pane or sentinel
 * content. Single source of truth for the literal so the admission boundary
 * and `extractPaneSummary` can never disagree.
 */
export function isPaneAbsenceSummary(summary: string, displayName: string, exitCode: number): boolean {
  return summary === paneAbsenceSummary(displayName, exitCode);
}

export function extractPaneSummary(context: SubagentResultContext, displayName: string): string {
  const { completionResult, surface, readPane } = context;
  const summary = readPane(surface, 200)
    .replace(/__SUBAGENT_DONE_\d+__/, "")
    .trimEnd();

  if (summary) return summary;

  return paneAbsenceSummary(displayName, completionResult.exitCode);
}
