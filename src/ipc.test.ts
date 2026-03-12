import { describe, expect, it } from 'vitest';

import { resolveOutboundContainerPath } from './ipc.js';

describe('resolveOutboundContainerPath', () => {
  it('maps a group workspace file to the host group folder', () => {
    const resolved = resolveOutboundContainerPath(
      'telegram_main',
      '/workspace/group/reports/daily.txt',
    );

    expect(resolved).toContain('/telegram_main/');
    expect(resolved).toMatch(/reports[\\/]+daily\.txt$/);
  });

  it('rejects paths outside the group workspace mount', () => {
    expect(
      resolveOutboundContainerPath(
        'telegram_main',
        '/workspace/project/README.md',
      ),
    ).toBeNull();
  });

  it('rejects traversal outside the mounted group folder', () => {
    expect(
      resolveOutboundContainerPath(
        'telegram_main',
        '/workspace/group/../../etc/passwd',
      ),
    ).toBeNull();
  });
});
