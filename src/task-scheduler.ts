import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  deleteSession,
  deleteSessionTranscript,
  getAllTasks,
  claimTaskForRun,
  getDueTasks,
  getMessagesSince,
  getRecentMessages,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
  setSession,
} from './db.js';
import {
  classifyOverflow,
  gracefulReset,
  hardResetSession,
  OverflowKind,
  resolveObservedOverflow,
} from './context-manager.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { sanitizeOutboundText } from './output-sanitization.js';
import { formatMessages } from './router.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function buildTaskScopedPrompt(task: ScheduledTask): string {
  const sections = [
    '[TASK-SCOPED CONTEXT]',
    `Task ID: ${task.id}`,
    `Schedule: ${task.schedule_type} (${task.schedule_value})`,
    '',
    '[TASK INSTRUCTIONS]',
    task.prompt,
  ];

  if (task.last_result) {
    sections.push('', '[PREVIOUS RUN SUMMARY]', task.last_result);
  }

  const recentMessages = task.last_run
    ? getMessagesSince(task.chat_jid, task.last_run, ASSISTANT_NAME, 3)
    : getRecentMessages(task.chat_jid, ASSISTANT_NAME, 3);

  if (recentMessages.length > 0) {
    sections.push(
      '',
      '[RECENT USER CONTEXT]',
      'Use these only as supplementary context. Prefer the task instructions above if they conflict.',
      formatMessages(recentMessages, TIMEZONE),
    );
  }

  return sections.join('\n');
}

function resetTaskGroupSession(
  task: ScheduledTask,
  sessions: Record<string, string>,
): boolean {
  const currentSessionId = sessions[task.group_folder];
  if (!currentSessionId) return false;

  hardResetSession(task.group_folder, currentSessionId, sessions);

  logger.warn(
    {
      taskId: task.id,
      groupFolder: task.group_folder,
      sessionId: currentSessionId,
    },
    'Scheduled task session auto-reset after repeated context overflow',
  );
  return true;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  _isRetry = false,
): Promise<void> {
  const startTime = Date.now();
  const finalizeRun = (status: 'success' | 'error', summary: string) => {
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status,
      result: status === 'success' ? summary : null,
      error: status === 'error' ? summary : null,
    });
    updateTaskAfterRun(task.id, computeNextRun(task), summary);
  };
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    // Still advance next_run so the task doesn't hammer every poll cycle
    const nextRun = computeNextRun(task);
    updateTaskAfterRun(
      task.id,
      nextRun,
      `Error: Group not found: ${task.group_folder}`,
    );
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  let overflowKind: OverflowKind = 'none';

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;
  const taskPrompt =
    task.context_mode === 'task-scoped'
      ? buildTaskScopedPrompt(task)
      : task.prompt;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: taskPrompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        channel: group.channel,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        // Classify any overflow signal first.
        const kind = classifyOverflow(streamedOutput.result);
        if (kind !== 'none') {
          overflowKind = kind;
          deps.queue.closeStdin(task.chat_jid);
          return;
        }

        // Non-visible output is treated as placeholder corruption.
        if (
          typeof streamedOutput.result === 'string' &&
          !sanitizeOutboundText(streamedOutput.result)
        ) {
          overflowKind = 'placeholder';
          logger.warn(
            { taskId: task.id, group: task.group_folder },
            'Task got non-visible output — will attempt context recovery',
          );
          deps.queue.closeStdin(task.chat_jid);
          return;
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        } else if (streamedOutput.status === 'success') {
          // Task completed but produced no result — visible in logs.
          logger.warn(
            { taskId: task.id, group: task.group_folder },
            'Task completed with no result output — user was not notified',
          );
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    const finalOverflowKind = resolveObservedOverflow(
      overflowKind,
      output.result,
    );

    if (_isRetry && finalOverflowKind !== 'none') {
      const reset = resetTaskGroupSession(task, sessions);
      if (reset) {
        await deps
          .sendMessage(
            task.chat_jid,
            '⚠️ Scheduled task context was reset after repeated context overflow. The next run will start with a fresh session.',
          )
          .catch(() => {});
      }
      finalizeRun(
        'error',
        'Error: Scheduled task context overflow persisted after recovery retry',
      );
      return;
    }

    // Handle context overflow: one-shot trim-then-reset, then retry once.
    if (finalOverflowKind !== 'none' && !_isRetry) {
      const notify = async (msg: string) => {
        await deps.sendMessage(task.chat_jid, msg).catch(() => {});
      };

      const resetResult = await gracefulReset(finalOverflowKind, {
        groupFolder: task.group_folder,
        sessionId: sessions[task.group_folder],
        sessions,
        notify,
      });

      if (resetResult === 'no_retry') {
        // input_too_large — user was notified; retrying would fail again.
        finalizeRun(
          'error',
          'Error: Scheduled task input exceeded context window',
        );
        return;
      }

      if (resetResult === undefined) {
        delete sessions[task.group_folder];
      } else {
        sessions[task.group_folder] = resetResult;
        setSession(task.group_folder, resetResult);
      }

      return runTask(task, deps, true);
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';

  if (error) {
    logger.error(
      { taskId: task.id, durationMs, error },
      'Scheduled task failed',
    );
  } else {
    logger.info({ taskId: task.id, durationMs }, 'Task completed');
  }

  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }
        if (!claimTaskForRun(currentTask.id)) {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
