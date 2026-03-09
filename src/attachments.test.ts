import { describe, expect, it } from 'vitest';

import {
  augmentMessagesWithAttachmentContext,
  buildAttachmentInstruction,
  toContainerMediaPath,
} from './attachments.js';
import { NewMessage } from './types.js';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'tg:1',
    sender: '123',
    sender_name: 'Alice',
    content: 'See attachment',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('toContainerMediaPath', () => {
  it('maps a stored host path into the container media directory', () => {
    expect(
      toContainerMediaPath('/tmp/groups/test-group/media/report.pdf'),
    ).toBe('/workspace/group/media/report.pdf');
  });

  it('returns undefined when no media file exists', () => {
    expect(toContainerMediaPath(undefined)).toBeUndefined();
  });
});

describe('buildAttachmentInstruction', () => {
  it('creates a Read-oriented instruction block for documents', () => {
    const result = buildAttachmentInstruction(
      makeMessage({
        media_kind: 'document',
        media_name: 'report.pdf',
        media_file: '/tmp/groups/test-group/media/report.pdf',
      }),
    );

    expect(result).toContain('[Attachment metadata]');
    expect(result).toContain('kind: document');
    expect(result).toContain(
      'container_path: /workspace/group/media/report.pdf',
    );
    expect(result).toContain('use the Read tool');
    expect(result).toContain('for PDFs, use Read directly');
  });

  it('returns null for photo attachments', () => {
    expect(
      buildAttachmentInstruction(
        makeMessage({
          media_kind: 'photo',
          media_file: '/tmp/groups/test-group/media/photo.jpg',
        }),
      ),
    ).toBeNull();
  });
});

describe('augmentMessagesWithAttachmentContext', () => {
  it('appends attachment instructions once', async () => {
    const msg = makeMessage({
      media_kind: 'document',
      media_name: 'report.pdf',
      media_file: '/tmp/groups/test-group/media/report.pdf',
    });

    await augmentMessagesWithAttachmentContext([msg]);
    const once = msg.content;
    await augmentMessagesWithAttachmentContext([msg]);

    expect(msg.content).toBe(once);
    expect(msg.content).toContain(
      'container_path: /workspace/group/media/report.pdf',
    );
  });
});
