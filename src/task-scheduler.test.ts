import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunContainerAgent, mockLoggerError, mockLoggerInfo } = vi.hoisted(
  () => ({
    mockRunContainerAgent: vi.fn(),
    mockLoggerError: vi.fn(),
    mockLoggerInfo: vi.fn(),
  }),
);

vi.mock('./container-runner.js', () => ({
  runContainerAgent: mockRunContainerAgent,
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  storeChatMetadata,
  storeMessage,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    mockRunContainerAgent.mockReset();
    mockLoggerError.mockReset();
    mockLoggerInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('claims due tasks before enqueueing to prevent repeat scheduling while running', async () => {
    createTask({
      id: 'task-claim-before-enqueue',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(getTaskById('task-claim-before-enqueue')?.status).toBe('running');
  });

  it('records recurring task failures without logging them as completed', async () => {
    createTask({
      id: 'task-timeout',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'run and fail',
      schedule_type: 'cron',
      schedule_value: '0 23 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    mockRunContainerAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'Container timed out after 1800000ms',
    });

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        main: {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          channel: 'telegram',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-timeout');
    expect(task?.status).toBe('active');
    expect(task?.last_result).toContain('Error: Container timed out');
    expect(task?.next_run).not.toBeNull();

    expect(
      mockLoggerInfo.mock.calls.some(([, msg]) => msg === 'Task completed'),
    ).toBe(false);
    expect(
      mockLoggerError.mock.calls.some(
        ([payload, msg]) =>
          msg === 'Scheduled task failed' &&
          payload.error === 'Container timed out after 1800000ms',
      ),
    ).toBe(true);
  });

  it('builds task-scoped prompts from task instructions, previous result, and recent user messages', async () => {
    createTask({
      id: 'task-scoped',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'Send the daily market summary.',
      schedule_type: 'cron',
      schedule_value: '0 23 * * *',
      context_mode: 'task-scoped',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    updateTaskAfterRun(
      'task-scoped',
      new Date(Date.now() + 3_600_000).toISOString(),
      'Yesterday summary was delayed due to market holiday.',
    );
    updateTask('task-scoped', {
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    storeChatMetadata('group@g.us', '2099-02-22T00:00:01.000Z');
    storeMessage({
      id: 'msg-task-scoped',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: '오늘은 선물 지수도 함께 봐줘.',
      timestamp: '2099-02-22T00:05:00.000Z',
      is_from_me: false,
    });

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'ok',
    });

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        main: {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          channel: 'telegram',
          isMain: true,
        },
      }),
      getSessions: () => ({ main: 'shared-group-session' }),
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const containerInput = mockRunContainerAgent.mock.calls[0][1];
    expect(containerInput.sessionId).toBeUndefined();
    expect(containerInput.prompt).toContain('[TASK-SCOPED CONTEXT]');
    expect(containerInput.prompt).toContain('Send the daily market summary.');
    expect(containerInput.prompt).toContain(
      'Yesterday summary was delayed due to market holiday.',
    );
    expect(containerInput.prompt).toContain('오늘은 선물 지수도 함께 봐줘.');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
