import https from 'https';
import path from 'path';
import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { saveMedia } from '../media.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

import { registerChannel, ChannelOpts } from './registry.js';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

const MAX_MESSAGE_LENGTH = 4096;
const SEND_RETRY_COUNT = 3;
const SEND_RETRY_DELAY_MS = 2000;
const POLLING_RETRY_DELAY_MS = 10_000;
const POLLING_WATCHDOG_MS = 90_000;

type TelegramMediaKind = 'photo' | 'video' | 'voice' | 'audio' | 'document';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private connected = false;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.shuttingDown = false;

    // Force IPv4 for all API calls (WSL2 has unreliable IPv6 to Telegram)
    const ipv4Agent = new https.Agent({ family: 4 });
    this.bot = new Bot(this.botToken, {
      client: { baseFetchConfig: { agent: ipv4Agent } },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    const getChatName = (ctx: any, senderName?: string) =>
      ctx.chat.type === 'private'
        ? senderName ||
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Private'
        : ctx.chat.title || `tg:${ctx.chat.id}`;

    const emitMetadata = (ctx: any, timestamp: string, senderName?: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        getChatName(ctx, senderName),
        'telegram',
        isGroup,
      );
    };

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (
      ctx: any,
      placeholder: string,
      filePath?: string,
      mediaKind?: TelegramMediaKind,
      mediaName?: string,
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      emitMetadata(ctx, timestamp, senderName);

      const content = filePath
        ? `${placeholder}${caption}\nfile: ${filePath}`
        : `${placeholder}${caption}`;
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        media_kind: mediaKind,
        media_name: mediaName,
        media_file: filePath,
        image_file: placeholder === '[Photo received]' ? filePath : undefined,
      });
    };

    const inferExtension = (
      filePath?: string,
      fileName?: string,
      fallback = '.bin',
    ) => {
      const source = fileName || filePath || '';
      const ext = path.extname(source);
      return ext || fallback;
    };

    const downloadTelegramFile = async (filePath: string): Promise<Buffer> => {
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;

      return new Promise<Buffer>((resolve, reject) => {
        const request = https.get(
          fileUrl,
          {
            family: 4,
            timeout: 30000,
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(
                new Error(`Telegram file download failed with ${res.statusCode}`),
              );
              return;
            }

            const chunks: Buffer[] = [];
            res.on('data', (chunk) =>
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
            );
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          },
        );

        request.on('timeout', () => {
          request.destroy(new Error('Telegram file download timed out'));
        });
        request.on('error', reject);
      });
    };

    const storeDownloadedMedia = async (
      ctx: any,
      kind: TelegramMediaKind,
      placeholder: string,
      fallbackExtension: string,
      fileName?: string,
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        const file = await ctx.getFile();
        if (!file.file_path) throw new Error('Telegram file path missing');

        const buffer = await downloadTelegramFile(file.file_path);
        const extension = inferExtension(
          file.file_path,
          fileName,
          fallbackExtension,
        );
        const filename = await saveMedia(group.folder, buffer, extension, kind);
        const groupDir = resolveGroupFolderPath(group.folder);
        const savedPath = path.join(groupDir, 'media', filename);

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id.toString() ||
          'Unknown';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

        emitMetadata(ctx, timestamp, senderName);

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content:
            kind === 'photo'
              ? `${placeholder}${caption}\nimage_file: ${savedPath}`
              : `${placeholder}${caption}\nfile: ${savedPath}`,
          timestamp,
          is_from_me: false,
          media_kind: kind,
          media_name: fileName,
          media_file: savedPath,
          image_file: kind === 'photo' ? savedPath : undefined,
        });

        logger.info(
          { chatJid, filename, kind, sender: senderName },
          'Telegram media downloaded and stored',
        );
      } catch (err) {
        logger.error({ err, kind }, 'Failed to download Telegram media');
        storeNonText(
          ctx,
          placeholder.replace(' received', ''),
          undefined,
          kind,
          fileName,
        );
      }
    };

    this.bot.on('message:photo', async (ctx) => {
      await storeDownloadedMedia(ctx, 'photo', '[Photo received]', '.jpg');
    });
    this.bot.on('message:video', async (ctx) => {
      await storeDownloadedMedia(
        ctx,
        'video',
        '[Video received]',
        '.mp4',
        ctx.message.video?.file_name,
      );
    });
    this.bot.on('message:voice', async (ctx) => {
      await storeDownloadedMedia(ctx, 'voice', '[Voice message received]', '.ogg');
    });
    this.bot.on('message:audio', async (ctx) => {
      await storeDownloadedMedia(
        ctx,
        'audio',
        '[Audio received]',
        '.mp3',
        ctx.message.audio?.file_name,
      );
    });
    this.bot.on('message:document', async (ctx) => {
      const name = ctx.message.document?.file_name;
      await storeDownloadedMedia(
        ctx,
        'document',
        `[Document received${name ? `: ${name}` : ''}]`,
        '.bin',
        name,
      );
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    this.connectPromise = new Promise<void>((resolve) => {
      this.startPolling(() => resolve());
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise ?? Promise.resolve();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot || !this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Telegram disconnected, message queued',
      );
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const chunks = this.splitMessage(text);

    for (const chunk of chunks) {
      let retries = SEND_RETRY_COUNT;
      let success = false;

      while (retries > 0 && !success) {
        try {
          await this.bot.api.sendMessage(numericId, chunk);
          success = true;
          logger.info({ jid, length: chunk.length }, 'Telegram message sent');
        } catch (err) {
          retries--;
          if (retries > 0) {
            logger.warn(
              {
                jid,
                err: (err as Error).message,
                retriesLeft: retries,
              },
              'Failed to send Telegram message, retrying...',
            );
            await new Promise((resolve) =>
              setTimeout(resolve, SEND_RETRY_DELAY_MS),
            );
          } else {
            this.outgoingQueue.push({ jid, text: chunk });
            logger.error(
              { jid, err, queueSize: this.outgoingQueue.length },
              'Failed to send Telegram message, queued for retry',
            );
          }
        }
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !this.connected || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  private startPolling(onFirstConnect?: () => void) {
    if (!this.bot || this.shuttingDown) return;

    logger.debug('Starting Telegram bot polling...');

    let started = false;
    const watchdog = setTimeout(() => {
      if (started || this.shuttingDown) return;

      logger.warn('Telegram bot polling hung (no onStart within 90s) — restarting');
      this.connected = false;
      this.bot?.stop();
      this.scheduleReconnect(onFirstConnect, 2_000);
    }, POLLING_WATCHDOG_MS);

    this.bot
      .start({
        onStart: (botInfo) => {
          started = true;
          this.connected = true;
          clearTimeout(watchdog);
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          if (onFirstConnect) {
            onFirstConnect();
            onFirstConnect = undefined;
          }
          this.flushOutgoingQueue().catch((err) =>
            logger.error({ err }, 'Failed to flush Telegram outgoing queue'),
          );
        },
      })
      .catch((err) => {
        clearTimeout(watchdog);
        this.connected = false;
        if (this.shuttingDown) return;

        logger.error(
          { err: err.message },
          'Telegram bot polling error — retrying in 10s',
        );
        this.scheduleReconnect(onFirstConnect, POLLING_RETRY_DELAY_MS);
      });
  }

  private scheduleReconnect(
    onFirstConnect?: () => void,
    delayMs = POLLING_RETRY_DELAY_MS,
  ) {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startPolling(onFirstConnect);
    }, delayMs);
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chars = Array.from(text);
    const chunks: string[] = [];
    let cursor = 0;

    while (cursor < chars.length) {
      const maxEnd = Math.min(cursor + MAX_MESSAGE_LENGTH, chars.length);
      let splitAt = maxEnd;

      if (maxEnd < chars.length) {
        for (let i = maxEnd; i > cursor; i--) {
          if (chars[i - 1] === '\n' || chars[i - 1] === ' ') {
            splitAt = i;
            break;
          }
        }
      }

      if (splitAt === cursor) splitAt = maxEnd;
      chunks.push(chars.slice(cursor, splitAt).join('').trimEnd());
      cursor = splitAt;
      while (cursor < chars.length && chars[cursor] === ' ') cursor++;
    }

    return chunks.filter((chunk) => chunk.length > 0);
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (!this.connected || !this.bot || this.flushing || this.outgoingQueue.length === 0) {
      return;
    }

    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Telegram outgoing queue',
      );
      while (this.outgoingQueue.length > 0 && this.connected && this.bot) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}
