import https from 'https';
import path from 'path';
import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { saveMedia } from '../media.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

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

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
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

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
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

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const buffer = await new Promise<Buffer>((resolve, reject) => {
          https
            .get(
              fileUrl,
              {
                family: 4, // Force IPv4 to avoid ENETUNREACH/ETIMEDOUT issues with IPv6
                timeout: 30000,
              },
              (res) => {
                const chunks: any[] = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
              },
            )
            .on('error', reject);
        });

        const filename = await saveMedia(group.folder, buffer, '.jpg', 'photo');
        const groupDir = path.resolve(process.cwd(), 'groups', group.folder);
        const imagePath = path.join(groupDir, 'media', filename);

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id.toString() ||
          'Unknown';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

        // Store chat metadata for discovery
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `[Photo received]${caption}\nimage_file: ${imagePath}`,
          timestamp,
          is_from_me: false,
          image_file: imagePath,
        });

        logger.info(
          { chatJid, filename, sender: senderName },
          'Telegram photo downloaded and stored',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram photo');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
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

    // Start polling with retry on transient network failures (e.g. WSL2 startup)
    const startPolling = () => {
      logger.debug('Starting Telegram bot polling...');

      // Watchdog: if onStart hasn't fired within 90s, the polling is hung — restart it.
      // Telegram holds a ~60s lock per bot token after a prior connection, so we give
      // it time to release before declaring a hang.
      let connected = false;
      const watchdog = setTimeout(() => {
        if (!connected) {
          logger.warn(
            'Telegram bot polling hung (no onStart within 90s) — restarting',
          );
          this.bot!.stop().catch(() => {});
          setTimeout(startPolling, 2_000);
        }
      }, 90_000);

      this.bot!.start({
        onStart: (botInfo) => {
          connected = true;
          clearTimeout(watchdog);
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
        },
      }).catch((err) => {
        clearTimeout(watchdog);
        logger.error(
          { err: err.message },
          'Telegram bot polling error — retrying in 10s',
        );
        setTimeout(startPolling, 10_000);
      });
    };
    startPolling();

    return Promise.resolve();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;

    // Split text into chunks if it's too long
    const chunks = [];
    if (text.length <= MAX_LENGTH) {
      chunks.push(text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }
    }

    for (const chunk of chunks) {
      let retries = 3;
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
              { jid, err: (err as Error).message, retriesLeft: retries },
              'Failed to send Telegram message, retrying...',
            );
            await new Promise((resolve) => setTimeout(resolve, 2000)); // 2초 대기 후 재시도
          } else {
            logger.error(
              { jid, err },
              'Failed to send Telegram message after retries',
            );
          }
        }
      }
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
