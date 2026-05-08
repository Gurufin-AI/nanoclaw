/**
 * Shared routing context for tool-progress notifications.
 *
 * poll-loop sets this before each provider query; claude.ts reads it in
 * preToolUseHook to write progress messages directly to outbound.db.
 */
export interface ProgressRouting {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

let current: ProgressRouting | null = null;

export function setProgressRouting(r: ProgressRouting | null): void {
  current = r;
}

export function getProgressRouting(): ProgressRouting | null {
  return current;
}
