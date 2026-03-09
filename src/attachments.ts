import path from 'path';

import { NewMessage } from './types.js';

export function toContainerMediaPath(mediaFile?: string): string | undefined {
  if (!mediaFile) return undefined;

  const base = path.basename(mediaFile);
  if (!base) return undefined;

  return `/workspace/group/media/${base}`;
}

export function buildAttachmentInstruction(message: NewMessage): string | null {
  if (
    !message.media_file ||
    !message.media_kind ||
    message.media_kind === 'photo'
  ) {
    return null;
  }

  const containerPath = toContainerMediaPath(message.media_file);
  if (!containerPath) return null;

  const lines = ['[Attachment metadata]'];
  lines.push(`kind: ${message.media_kind}`);
  if (message.media_name) lines.push(`name: ${message.media_name}`);
  lines.push(`container_path: ${containerPath}`);
  lines.push(
    'instruction: use the Read tool on container_path to inspect this attachment.',
  );
  if (message.media_kind === 'document') {
    lines.push(
      'instruction: for PDFs, use Read directly on the PDF path instead of asking the user to paste the text.',
    );
  }
  return lines.join('\n');
}

export async function augmentMessagesWithAttachmentContext(
  messages: NewMessage[],
): Promise<void> {
  for (const message of messages) {
    if (message.content.includes('[Attachment metadata]')) continue;
    const context = buildAttachmentInstruction(message);
    if (!context) continue;

    message.content = `${message.content}\n\n${context}`;
  }
}
