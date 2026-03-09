import { toContainerMediaPath } from './attachments.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const attrs = [
      `sender="${escapeXml(m.sender_name)}"`,
      `time="${escapeXml(displayTime)}"`,
    ];
    if (m.media_kind) attrs.push(`media_kind="${escapeXml(m.media_kind)}"`);
    if (m.media_name) attrs.push(`media_name="${escapeXml(m.media_name)}"`);
    if (m.media_file) attrs.push(`media_file="${escapeXml(m.media_file)}"`);
    const containerMediaFile = toContainerMediaPath(m.media_file);
    if (containerMediaFile) {
      attrs.push(`container_media_file="${escapeXml(containerMediaFile)}"`);
    }
    if (m.image_file) attrs.push(`image_file="${escapeXml(m.image_file)}"`);

    return `<message ${attrs.join(' ')}>${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
