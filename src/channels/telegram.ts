/**
 * Telegram channel adapter for NanoClaw v2.
 *
 * Uses grammy for bot polling. Forces IPv4 on all API calls for WSL2 stability.
 * JID / platformId format: numeric Telegram chat ID as string (e.g. "-1001234567890").
 * supportsThreads: false — Telegram treats each chat as a conversation, not a thread tree.
 *
 * Reads credentials from env: TELEGRAM_BOT_TOKEN.
 */
import https from 'https';
import path from 'path';
import fs from 'fs';

import { Bot, InputFile } from 'grammy';
import type { Message } from 'grammy/types';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundFile, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const MAX_MESSAGE_LENGTH = 4096;
const POLLING_WATCHDOG_MS = 90_000;
const POLLING_RETRY_DELAY_MS = 10_000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

type TelegramMediaKind = 'photo' | 'video' | 'voice' | 'audio' | 'document';

function makeId(): string {
  return `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let cut = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    if (cut <= 0) cut = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<{ buffer: Buffer; path: string } | null> {
  try {
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const infoData: Buffer = await new Promise((resolve, reject) => {
      https
        .get(infoUrl, { family: 4 }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('error', reject);
    });
    const info = JSON.parse(infoData.toString());
    if (!info.ok || !info.result?.file_path) return null;
    const filePath: string = info.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const fileData: Buffer = await new Promise((resolve, reject) => {
      https
        .get(fileUrl, { family: 4 }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('error', reject);
    });
    return { buffer: fileData, path: filePath };
  } catch (err) {
    log.warn('Failed to download Telegram file', { fileId, err });
    return null;
  }
}

function saveMediaToDisk(buffer: Buffer, ext: string, prefix = 'tg'): string {
  const mediaDir = path.join(DATA_DIR, 'telegram-media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const filename = `${prefix}_${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`;
  const fullPath = path.join(mediaDir, filename);
  fs.writeFileSync(fullPath, buffer);
  return fullPath;
}

function extensionForKind(kind: TelegramMediaKind, mimeType?: string): string {
  if (kind === 'photo') return '.jpg';
  if (kind === 'voice' || kind === 'audio') return '.ogg';
  if (kind === 'video') return '.mp4';
  // For documents, guess from mime
  if (mimeType) {
    const m = mimeType.split('/')[1];
    if (m) return `.${m.split(';')[0]}`;
  }
  return '.bin';
}

function createAdapter(): ChannelAdapter {
  let bot: Bot | null = null;
  let connected = false;
  let shuttingDown = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let outgoingQueue: Array<{
    platformId: string;
    text?: string;
    file?: OutboundFile;
  }> = [];
  let flushing = false;
  let setupConfig: ChannelSetup | null = null;

  async function flushQueue(): Promise<void> {
    if (flushing || !connected || !bot) return;
    flushing = true;
    while (outgoingQueue.length > 0 && connected && bot) {
      const item = outgoingQueue.shift()!;
      try {
        if (item.text !== undefined) {
          await sendTextTo(bot, item.platformId, item.text);
        } else if (item.file) {
          await sendFileTo(bot, item.platformId, item.file);
        }
      } catch (err) {
        log.warn('Failed to flush queued Telegram message', { err });
      }
    }
    flushing = false;
  }

  async function sendTextTo(b: Bot, platformId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await b.api.sendMessage(platformId, chunk);
    }
  }

  async function sendFileTo(b: Bot, platformId: string, file: OutboundFile): Promise<void> {
    await b.api.sendDocument(platformId, new InputFile(file.data, file.filename));
  }

  function scheduleReconnect(config: ChannelSetup): void {
    if (shuttingDown) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void startPolling(config);
    }, POLLING_RETRY_DELAY_MS);
  }

  async function startPolling(config: ChannelSetup): Promise<void> {
    if (shuttingDown) return;

    const ipv4Agent = new https.Agent({ family: 4 });
    bot = new Bot(TELEGRAM_BOT_TOKEN, {
      client: { baseFetchConfig: { agent: ipv4Agent } },
    });

    bot.command('chatid', (ctx) => {
      const id = ctx.chat.id.toString();
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as { title?: string }).title || 'Unknown';
      void ctx.reply(`Chat ID: \`${id}\`\nName: ${chatName}\nType: ${chatType}`, {
        parse_mode: 'Markdown',
      });
    });

    bot.command('ping', (ctx) => void ctx.reply('pong'));

    bot.on('message', async (ctx) => {
      const msg: Message = ctx.message;
      const chatId = `telegram:${msg.chat.id}`;
      const chatType = msg.chat.type;
      const isGroup = chatType === 'group' || chatType === 'supergroup';
      const senderId = msg.from?.id?.toString() ?? 'unknown';
      const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown';

      // Detect bot mention
      const botUsername = bot?.botInfo?.username ?? '';
      const isMentioned =
        msg.entities?.some(
          (e) => e.type === 'mention' && msg.text?.slice(e.offset + 1, e.offset + e.length) === botUsername,
        ) ?? false;

      let text = msg.text || msg.caption || '';

      // Translate @bot mention to trigger pattern
      if (isMentioned && !text.toLowerCase().startsWith(`@${ASSISTANT_NAME.toLowerCase()}`)) {
        text = `@${ASSISTANT_NAME} ${text.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '').trim()}`;
      }

      // Media handling
      let mediaKind: TelegramMediaKind | undefined;
      let mediaFileId: string | undefined;
      let mimeType: string | undefined;
      let mediaName: string | undefined;

      if (msg.photo?.length) {
        mediaKind = 'photo';
        mediaFileId = msg.photo[msg.photo.length - 1].file_id;
      } else if (msg.video) {
        mediaKind = 'video';
        mediaFileId = msg.video.file_id;
        mimeType = msg.video.mime_type;
        mediaName = msg.video.file_name;
      } else if (msg.voice) {
        mediaKind = 'voice';
        mediaFileId = msg.voice.file_id;
        mimeType = msg.voice.mime_type;
      } else if (msg.audio) {
        mediaKind = 'audio';
        mediaFileId = msg.audio.file_id;
        mimeType = msg.audio.mime_type;
        mediaName = msg.audio.file_name;
      } else if (msg.document) {
        mediaKind = 'document';
        mediaFileId = msg.document.file_id;
        mimeType = msg.document.mime_type;
        mediaName = msg.document.file_name;
      }

      let mediaFile: string | undefined;
      let imageFile: string | undefined;

      if (mediaFileId && mediaKind) {
        const downloaded = await downloadTelegramFile(TELEGRAM_BOT_TOKEN, mediaFileId);
        if (downloaded) {
          const ext = extensionForKind(mediaKind, mimeType);
          const savedPath = saveMediaToDisk(downloaded.buffer, ext, mediaKind);
          mediaFile = savedPath;
          if (mediaKind === 'photo') imageFile = savedPath;
        }
      }

      // Chat name metadata
      config.onMetadata(chatId, isGroup ? (ctx.chat as { title?: string }).title : senderName, isGroup);

      const content = {
        text,
        sender: senderName,
        senderId: `telegram:${senderId}`,
        media_kind: mediaKind,
        media_name: mediaName,
        media_file: mediaFile,
        image_file: imageFile,
        reply_to_message_id: msg.reply_to_message?.message_id?.toString(),
      };

      const inbound: InboundMessage = {
        id: `tg-${msg.message_id}`,
        kind: 'chat',
        content,
        timestamp: new Date(msg.date * 1000).toISOString(),
        isMention: isMentioned,
        isGroup,
      };

      try {
        await config.onInbound(chatId, null, inbound);
      } catch (err) {
        log.error('Telegram onInbound error', { err, chatId });
      }
    });

    return new Promise<void>((resolve) => {
      watchdogTimer = setTimeout(() => {
        log.warn('Telegram polling watchdog fired — assuming connected');
        connected = true;
        resolve();
        void flushQueue();
      }, POLLING_WATCHDOG_MS);

      bot!
        .start({
          onStart: () => {
            if (watchdogTimer) {
              clearTimeout(watchdogTimer);
              watchdogTimer = null;
            }
            connected = true;
            log.info('Telegram channel connected');
            resolve();
            void flushQueue();
          },
        })
        .catch((err) => {
          if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
          connected = false;
          if (!shuttingDown) {
            log.warn('Telegram polling error — reconnecting', { err });
            scheduleReconnect(config);
          }
        });
    });
  }

  const adapter: ChannelAdapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
      await startPolling(config);
    },

    async teardown(): Promise<void> {
      shuttingDown = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      if (bot) {
        try {
          await bot.stop();
        } catch {
          // best-effort
        }
        bot = null;
      }
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      // platform_id is stored as "telegram:<chat_id>" — strip the prefix for the API
      const chatId = platformId.startsWith('telegram:') ? platformId.slice('telegram:'.length) : platformId;
      platformId = chatId;
      const content = message.content as Record<string, unknown> | string | undefined;
      const text =
        typeof content === 'string'
          ? content
          : typeof content === 'object' && content
            ? String((content as Record<string, unknown>).text ?? '')
            : '';

      const files = message.files ?? [];

      if (!connected || !bot) {
        if (text) outgoingQueue.push({ platformId, text });
        for (const f of files) outgoingQueue.push({ platformId, file: f });
        return undefined;
      }

      try {
        if (text) await sendTextTo(bot, platformId, text);
        for (const f of files) await sendFileTo(bot, platformId, f);
      } catch (err) {
        log.warn('Telegram deliver error', { platformId, err });
      }

      return undefined;
    },

    async setTyping(platformId: string): Promise<void> {
      if (!bot || !connected) return;
      const chatId = platformId.startsWith('telegram:') ? platformId.slice('telegram:'.length) : platformId;
      try {
        await bot.api.sendChatAction(chatId, 'typing');
      } catch {
        // best-effort
      }
    },
  };

  return adapter;
}

if (TELEGRAM_BOT_TOKEN) {
  registerChannelAdapter('telegram', { factory: createAdapter });
}
