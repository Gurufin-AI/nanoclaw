/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  extractAssistantText,
  isPlaceholderResult,
  type AssistantMessagePayload,
  isSdkErrorResult,
  isSdkHostNotice,
  labelHostNotice,
  type SDKResultPayload,
  summarizeSdkError,
} from './output.js';
import {
  shouldEnableAnthropicOpenAiProxy,
  startAnthropicOpenAiProxy,
} from './anthropic-openai-proxy.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  channel: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  type?: 'progress' | 'result';
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const PLACEHOLDER_OUTPUT_RESULT = '__NANOCLAW_PLACEHOLDER_OUTPUT__';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function formatToolProgress(toolName: string, input: unknown): string | null {
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case 'Bash':
      return `⚙️ 명령 실행 중: \`${String(inp?.command ?? '').slice(0, 80)}\``;
    case 'WebSearch':
      return `🔍 검색 중: ${String(inp?.query ?? '')}`;
    case 'WebFetch':
      return `🌐 페이지 읽는 중...`;
    case 'Read':
      return `📖 파일 읽는 중: ${String(inp?.file_path ?? '')}`;
    case 'Write':
      return `✏️ 파일 작성 중: ${String(inp?.file_path ?? '')}`;
    case 'Edit':
      return `✏️ 파일 수정 중: ${String(inp?.file_path ?? '')}`;
    case 'Task':
      return `🤖 서브 에이전트 실행 중...`;
    case 'mcp__nanoclaw__send_message':
      return `📤 메시지 전송 중...`;
    default:
      return null;
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  fatalError: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  // Collect assistant text chunks in emission order; assembled at result time
  const assistantChunks: { seq: number; text: string }[] = [];
  let messageCount = 0;
  let resultCount = 0;
  let fatalError = false;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const channelInfo = `[Platform: ${containerInput.channel}]`;
  const toneInstruction = 'If the user\'s message doesn\'t require any specific action or tool use, provide a brief, helpful response or acknowledgment instead of remaining silent.';
  const attachmentInstruction =
    'If a message includes container_media_file, that path is readable inside the container. Use the Read tool on container_media_file to inspect attached documents and files. For PDFs, use Read directly on the PDF path instead of asking the user to paste or summarize the file manually.';
  const systemPrompt = globalClaudeMd
    ? { type: 'preset' as const, preset: 'claude_code' as const, append: `${channelInfo}\n${toneInstruction}\n${attachmentInstruction}\n\n${globalClaudeMd}` }
    : { type: 'preset' as const, preset: 'claude_code' as const, append: `${channelInfo}\n${toneInstruction}\n${attachmentInstruction}` };

  // Get model overrides from environment
  const modelId = sdkEnv['ANTHROPIC_DEFAULT_SONNET_MODEL'];
  const haikuModelId = sdkEnv['ANTHROPIC_DEFAULT_HAIKU_MODEL'];
  if (modelId) {
    log(`Bypassing SDK validation to use custom model (sonnet): ${modelId}`);
  }
  if (haikuModelId) {
    log(`Custom haiku model override active: ${haikuModelId}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      // Force the SDK to use our OpenRouter model ID by bypassing type validation
      model: modelId as any,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt,
      // Cap tool-call turns to prevent infinite retry loops (e.g. repeated
      // WebSearch on empty results). 20 turns is generous for complex tasks.
      maxTurns: 20,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
      ],
      // WebSearch is an Anthropic-native built-in; allowedTools alone cannot
      // exclude it. Explicitly disallow it for third-party models (llama.cpp,
      // OpenRouter custom) that don't have native search capability.
      disallowedTools: modelId ? ['WebSearch'] : [],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_CHANNEL: containerInput.channel,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      log(`Assistant RAW=${JSON.stringify(message)}`);
      const assistantText = extractAssistantText(
        message as { message?: AssistantMessagePayload },
      );
      if (assistantText) {
        assistantChunks.push({ seq: messageCount, text: assistantText });
      }

      // Emit progress for each tool_use block
      const msgContent = (message as any).message?.content ?? [];
      for (const block of msgContent) {
        if (block.type === 'tool_use') {
          const progressText = formatToolProgress(block.name, block.input);
          if (progressText) {
            log(`Progress: ${progressText}`);
            writeOutput({ type: 'progress', status: 'success', result: progressText });
          }
        }
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const sdkResult = message as SDKResultPayload;
      const textResult = 'result' in sdkResult ? sdkResult.result ?? null : null;

      // Deduplicate: remove any chunk whose text is contained in another chunk.
      // This handles nemotron's re-emission of the first chunk after the full response.
      const deduped = assistantChunks.filter(
        ({ text }, i) =>
          !assistantChunks.some(({ text: other }, j) => j !== i && other.includes(text)),
      );
      // Nemotron (OpenRouter) delivers chunks in reverse logical order: the tail
      // arrives first (low seq) and the head arrives last (high seq). Sort descending
      // so the head comes first. For all other models (Claude, etc.) chunks arrive in
      // natural order — sort ascending to preserve correct ordering.
      const isNemotron = typeof modelId === 'string' && modelId.toLowerCase().includes('nemotron');
      deduped.sort((a, b) => isNemotron ? b.seq - a.seq : a.seq - b.seq);
      const assembledText = deduped.length > 0
        ? deduped.map((c) => c.text).join('\n').trim() || null
        : null;
      log(`Assembled ${assistantChunks.length} chunk(s) → ${deduped.length} after dedup (${isNemotron ? 'desc' : 'asc'} order), text length=${assembledText?.length ?? 0}`);

      const outboundText = assembledText
        || (isPlaceholderResult(textResult) ? null : textResult)
        || null;
      const visibleText = isSdkHostNotice(sdkResult)
        ? labelHostNotice(outboundText)
        : outboundText;
      log(`Result #${resultCount}: subtype=${message.subtype} RAW=${JSON.stringify(message)}`);
      if (isSdkErrorResult(sdkResult)) {
        fatalError = true;
        writeOutput({
          status: 'error',
          result: visibleText,
          newSessionId,
          error: summarizeSdkError(sdkResult) || 'Agent SDK execution failed',
        });
        assistantChunks.length = 0;
        continue;
      }
      writeOutput({
        status: 'success',
        result:
          visibleText ||
          (isPlaceholderResult(textResult)
            ? PLACEHOLDER_OUTPUT_RESULT
            : null),
        newSessionId
      });
      assistantChunks.length = 0;
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, fatalError };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };
  let openAiCompatProxy:
    | { baseUrl: string; close: () => Promise<void> }
    | undefined;

  const upstreamBaseUrl = sdkEnv['ANTHROPIC_BASE_URL'];
  const realUpstreamBaseUrl =
    sdkEnv['NANOCLAW_UPSTREAM_BASE_URL'] || upstreamBaseUrl;
  if (shouldEnableAnthropicOpenAiProxy(realUpstreamBaseUrl)) {
    log(
      `Starting Anthropic->OpenAI compatibility proxy for ${realUpstreamBaseUrl}`,
    );
    openAiCompatProxy = await startAnthropicOpenAiProxy(upstreamBaseUrl!);
    sdkEnv['ANTHROPIC_BASE_URL'] = openAiCompatProxy.baseUrl;
    // Also update process.env so the SDK's internal Haiku/compact calls
    // (which read process.env directly, not the env option) go through
    // the proxy instead of hitting the upstream OpenAI-format server directly.
    process.env['ANTHROPIC_BASE_URL'] = openAiCompatProxy.baseUrl;
    log(`Compatibility proxy listening at ${openAiCompatProxy.baseUrl}`);
  }

  // Ensure model overrides are reflected in process.env so the SDK's internal
  // calls (which read process.env directly, not the env option) respect our overrides.
  // - ANTHROPIC_SMALL_FAST_MODEL: SDK's primary env var for haiku/compact calls
  // - ANTHROPIC_DEFAULT_HAIKU_MODEL: fallback haiku env var
  // - ANTHROPIC_DEFAULT_OPUS_MODEL: prevents SDK from escalating to opus when it
  //   detects a Max/Team subscription (KG() returns NV() for those tiers)
  const haikuOverride = sdkEnv['ANTHROPIC_DEFAULT_HAIKU_MODEL'];
  const sonnetOverride = sdkEnv['ANTHROPIC_DEFAULT_SONNET_MODEL'];
  if (haikuOverride) {
    process.env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = haikuOverride;
    process.env['ANTHROPIC_SMALL_FAST_MODEL'] = haikuOverride;
  }
  if (sonnetOverride) {
    process.env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = sonnetOverride;
    // Also override opus: when the SDK detects a Max/Team subscription it calls
    // KG() which returns NV() (opus). Pinning ANTHROPIC_DEFAULT_OPUS_MODEL to
    // the same free model prevents unexpected opus billing.
    process.env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = sonnetOverride;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      if (queryResult.fatalError) {
        log('Fatal SDK error reported during query, exiting');
        process.exit(1);
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    if (openAiCompatProxy) {
      try {
        await openAiCompatProxy.close();
      } catch (err) {
        log(
          `Failed to close compatibility proxy: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

main();
