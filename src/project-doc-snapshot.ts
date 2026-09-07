import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Docker Desktop caches single-file WSL bind mounts by source path. Replacing
 * that source with rename leaves its cached mount pointing at an unlinked inode.
 * Keep content-addressed snapshots in a host-only directory: existing containers
 * retain their instructions and new spawns get the current document.
 */
export function snapshotProjectDoc(source: string, snapshotDir: string): string {
  const content = fs.readFileSync(source);
  const digest = createHash('sha256').update(content).digest('hex');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshot = path.join(snapshotDir, `${digest}.md`);
  const tmp = path.join(snapshotDir, `.tmp-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    try {
      // Publish complete bytes without ever replacing an existing mount source.
      fs.linkSync(tmp, snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return snapshot;
}
