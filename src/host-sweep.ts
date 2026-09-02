/**
 * Host sweep — the periodic resync over all session mailboxes.
 *
 * The per-session body lives in src/reconcile-session.ts (`reconcileSession`,
 * the ReconcileFn shape from src/reconcile.ts); execution runs through the
 * keyed workqueue (src/reconcile-queue.ts). This module owns the resync
 * floor: every 60s it enqueues the singleton duties and every active
 * session, then re-arms once the tick's work has drained — so queue loss
 * costs latency, never correctness, and an explicit enqueue between ticks
 * can never be lost to a concurrent sweep. The re-exports below keep the
 * long-standing import surface of this module stable.
 */
import fs from 'fs';
import path from 'path';

import { INSTALL_SLUG } from './config.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { getActiveSessions } from './db/sessions.js';
import { peekSessionDriver } from './drivers/index.js';
import type { SessionWatch } from './drivers/types.js';
import { log } from './log.js';
import { registerReconcileEnqueue } from './reconcile-feeds.js';
import { createReconcileQueue, type InProcessReconcileQueue } from './reconcile-queue.js';
import { reconcileSession } from './reconcile-session.js';
import { sessionKey } from './reconcile.js';
import { sessionDir } from './session-manager.js';
import type { Session } from './types.js';

export {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
  shouldCloseTaskSession,
  type StuckDecision,
} from './reconcile-session.js';

const SWEEP_INTERVAL_MS = 60_000;

let running = false;
let queue: InProcessReconcileQueue | null = null;
let runtimeWatch: SessionWatch | null = null;

/** Coalesced enqueue for the event feeds; drops harmlessly once stopped. */
function feedEnqueue(sessionId: string): void {
  const feedQueue = queue;
  if (running && feedQueue) feedQueue.add(sessionKey(sessionId));
}

/**
 * Reconcile promptly when the runtime reports a session ended: due mail on a
 * dead session waits one queue turn instead of the next resync tick. Arms
 * only against a driver that already exists — the sweep never instantiates
 * one, so suites (and hosts) that never selected a runtime are untouched.
 * Events are hints (they may drop, duplicate, or reference foreign keys);
 * the enqueue re-reads truth, so all of that is safe by construction.
 */
function armRuntimeWatch(): void {
  const driver = peekSessionDriver();
  // Raw test fakes may lack watchSessions; never crash on them.
  if (!driver || typeof driver.watchSessions !== 'function') return;
  /* eslint-disable no-catch-all/no-catch-all -- a watch backend that cannot subscribe costs latency (the resync floor covers it), never the boot */
  try {
    runtimeWatch = driver.watchSessions(INSTALL_SLUG, (event) => {
      if (event.kind !== 'terminal' || !event.key.sessionId) return;
      feedEnqueue(event.key.sessionId);
    });
  } catch (err) {
    log.warn('Runtime watch feed unavailable — the resync floor covers it', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export function startHostSweep(): void {
  if (running) return;
  running = true;
  queue = createReconcileQueue({
    reconcile: reconcileSession,
    singletons: {
      // Re-heal the egress network so already-running agents keep their
      // gateway hop if it was detached out-of-band. Best-effort: a heal
      // failure isn't a leak (agents stay on the internal net), so log and
      // continue — never surface a throw into queue backoff. No-op when
      // lockdown is disabled.
      'singleton:egress-reheal': async () => {
        try {
          ensureEgressNetwork();
        } catch (err) {
          log.error('Egress lockdown re-heal failed', { err });
        }
      },
      // Finalize any "Reject with reason…" holds whose reply window elapsed
      // (admin ghosted, or the host restarted mid-capture). Central-DB scan,
      // once per tick — not per session.
      // MODULE-HOOK:approvals-reason-sweep:start
      'singleton:approvals-scan': async () => {
        try {
          const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
          await sweepAwaitingReasonRejects();
        } catch (err) {
          log.error('Reject-with-reason sweep failed', { err });
        }
      },
      // MODULE-HOOK:approvals-reason-sweep:end
    },
  });
  // Event feeds — additive over the resync floor: mail writes and runtime
  // terminal events land as coalesced enqueues, so behavior only gets
  // faster, never different, and a lost event costs at most one tick.
  registerReconcileEnqueue(feedEnqueue);
  armRuntimeWatch();
  void sweep();
}

export function stopHostSweep(): void {
  running = false;
  registerReconcileEnqueue(null);
  const stoppingWatch = runtimeWatch;
  runtimeWatch = null;
  if (stoppingWatch) {
    /* eslint-disable no-catch-all/no-catch-all -- a watch backend that is already gone must not block shutdown */
    try {
      stoppingWatch.stop();
    } catch (err) {
      log.warn('Runtime watch feed stop failed', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  const stopping = queue;
  queue = null;
  if (stopping) void stopping.shutdown();
}

async function sweep(): Promise<void> {
  // Capture the queue for the whole tick: stopHostSweep nulls the module
  // reference mid-flight, and a stopping queue drops adds harmlessly.
  const tickQueue = queue;
  if (!running || !tickQueue) return;

  // Tick order matches the loop this replaces: egress re-heal, then every
  // active session, then the approvals scan — serial through the queue.
  tickQueue.add('singleton:egress-reheal');
  try {
    const sessions = await getActiveSessions();
    for (const session of sessions) {
      tickQueue.add(sessionKey(session.id));
      await sweepXTasks(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }
  tickQueue.add('singleton:approvals-scan');

  // The tick ends — and the next one is armed — only after everything this
  // tick enqueued has run. Delayed backoff retries don't hold the tick open.
  await tickQueue.idle();
  if (!running) return;
  setTimeout(() => void sweep(), SWEEP_INTERVAL_MS);
}

/** Process X integration task files written by the container-side X tools. */
async function sweepXTasks(session: Session): Promise<void> {
  if (!process.env.X_AUTH_TOKEN) return;

  const sessDir = sessionDir(session.agent_group_id, session.id);
  const tasksDir = path.join(sessDir, 'x_tasks');
  const resultsDir = path.join(sessDir, 'x_results');

  let files: string[];
  try {
    files = fs.readdirSync(tasksDir).filter((file) => file.endsWith('.json'));
  } catch {
    return;
  }
  if (files.length === 0) return;

  fs.mkdirSync(resultsDir, { recursive: true });
  for (const file of files) {
    const taskPath = path.join(tasksDir, file);
    let task: Record<string, unknown>;
    try {
      task = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
      fs.unlinkSync(taskPath);
    } catch {
      continue;
    }

    const requestId = task.requestId as string;
    if (!requestId) continue;
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    try {
      // @ts-ignore -- optional local skill file lives outside rootDir.
      const { handleXIpc } = await import('../../.claude/skills/x-integration/host.js');
      const handled = await handleXIpc(task, session.agent_group_id, true, path.join(sessDir, '..', '..'));
      if (!handled) {
        fs.writeFileSync(resultPath, JSON.stringify({ success: false, message: `Unknown X task type: ${task.type}` }));
      }
    } catch (err) {
      log.warn('X task dispatch error', { requestId, err });
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          success: false,
          message: `X task failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }
  }
}
