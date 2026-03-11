import path from 'path';
import fs from 'fs';
import { DATA_DIR } from './config.js';
import { deleteSession, deleteSessionTranscript, setSession } from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Overflow classification
// ---------------------------------------------------------------------------

export type OverflowKind =
  | 'session_too_large' // accumulated history exceeded model context
  | 'input_too_large' // the single user message is itself too long
  | 'placeholder' // corrupt / non-visible / placeholder output
  | 'none';

/**
 * Classify what kind of overflow a raw container result string represents.
 * Returns 'none' when the result is healthy.
 */
export function classifyOverflow(result: string | null | undefined): OverflowKind {
  if (!result) return 'none';
  if (result.includes('exceed_context_size_error')) return 'session_too_large';
  if (result === 'Prompt is too long') return 'input_too_large';
  if (result === '__NANOCLAW_PLACEHOLDER_OUTPUT__') return 'placeholder';
  return 'none';
}

// ---------------------------------------------------------------------------
// Transcript path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a group's Claude Agent SDK session transcript.
 */
export function transcriptPath(groupFolder: string, sessionId: string): string {
  return path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

// ---------------------------------------------------------------------------
// Transcript trimming
// ---------------------------------------------------------------------------

/**
 * Trim the oldest turns from a session transcript while strictly preserving:
 *  - Line 0: the system-prompt / SDK init entry (never removed)
 *  - The most recent `keepLines` lines of conversation
 *
 * The trimming is a pure file-stream operation (read → slice → write) with
 * no LLM calls, keeping latency minimal for local-model deployments.
 *
 * @returns Number of lines removed (0 = nothing to trim, -1 = file missing)
 */
export function trimTranscript(
  groupFolder: string,
  sessionId: string,
  keepLines = 40,
): number {
  const filePath = transcriptPath(groupFolder, sessionId);

  if (!fs.existsSync(filePath)) return -1;

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Single line (just the system prompt) — nothing left to remove.
  if (lines.length <= 1) return -1;

  const systemPromptLine = lines[0];
  const history = lines.slice(1);

  // Already within budget.
  if (history.length <= keepLines) return 0;

  const trimmed = history.slice(history.length - keepLines);
  const removedCount = history.length - keepLines;

  const newContent = [systemPromptLine, ...trimmed].join('\n') + '\n';
  fs.writeFileSync(filePath, newContent, 'utf8');

  logger.info(
    { groupFolder, sessionId, removedCount, remaining: trimmed.length + 1 },
    'Trimmed session transcript — preserved system prompt + most recent turns',
  );
  return removedCount;
}

// ---------------------------------------------------------------------------
// Graceful reset (one-shot trim then reset)
// ---------------------------------------------------------------------------

export interface ContextResetOptions {
  groupFolder: string;
  /** Current session ID for this group (may be undefined for fresh sessions). */
  sessionId: string | undefined;
  /** Live sessions map shared with the caller — mutated in place on full reset. */
  sessions: Record<string, string | undefined>;
  /** Send a user-facing notification message. */
  notify: (msg: string) => Promise<void>;
}

/**
 * Handle a context overflow event using a one-shot trim-then-reset strategy:
 *
 *  input_too_large  → Notify the user immediately; leave history untouched.
 *                     Retrying with the same prompt would fail again, so the
 *                     caller should NOT retry.
 *
 *  session_too_large / placeholder →
 *    1. Attempt to trim the .jsonl to the last 40 turns.
 *       If lines were removed, notify the user and allow one retry.
 *    2. If trimming had nothing to remove (transcript already minimal), fall
 *       back to a full session + transcript delete as a last resort.
 *
 * Returns the session ID the caller should use for the retry:
 *  - Same sessionId  → trim succeeded; retry with existing session.
 *  - undefined       → full reset; start a fresh session.
 *  - 'no_retry'      → input_too_large; caller must NOT retry.
 */
export async function gracefulReset(
  kind: OverflowKind,
  opts: ContextResetOptions,
): Promise<string | undefined | 'no_retry'> {
  const { groupFolder, sessionId, sessions, notify } = opts;

  // ------------------------------------------------------------------
  // Case 1: The prompt itself is the problem — history is irrelevant.
  // ------------------------------------------------------------------
  if (kind === 'input_too_large') {
    await notify(
      '⚠️ Your message is too long for the model context window. ' +
        'Please send a shorter prompt.',
    );
    logger.warn({ groupFolder }, 'Input too large — user notified, no session reset');
    return 'no_retry';
  }

  // ------------------------------------------------------------------
  // Case 2: Accumulated session history exceeded the context window,
  // or the agent returned corrupt/placeholder output.
  // ------------------------------------------------------------------
  if (kind === 'session_too_large' || kind === 'placeholder') {
    if (sessionId) {
      const removed = trimTranscript(groupFolder, sessionId, 40);

      if (removed > 0) {
        // Trim succeeded — retry with the same session, smaller history.
        await notify(
          '⚠️ Context limit reached — oldest conversation history has been ' +
            'trimmed to continue.',
        );
        logger.info(
          { groupFolder, sessionId, removed },
          'Transcript trimmed — retrying with same session',
        );
        return sessionId;
      }

      // removed === 0: transcript was already at or below keepLines.
      // removed === -1: transcript file missing.
      // Fall through to full reset.
      logger.warn(
        { groupFolder, sessionId, removed },
        'Trim had nothing to remove — falling back to full session reset',
      );
    }

    // Full reset: wipe in-memory state, SQLite row, and on-disk transcript.
    delete sessions[groupFolder];
    deleteSession(groupFolder);
    if (sessionId) deleteSessionTranscript(groupFolder, sessionId);

    await notify(
      '⚠️ Context limit reached — conversation history has been cleared ' +
        'to continue.',
    );
    logger.warn({ groupFolder }, 'Session fully reset due to context overflow');
    return undefined; // caller should start a fresh session
  }

  // Should not be reached, but safe default.
  return sessionId;
}
