import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it } from 'vitest';

import { snapshotProjectDoc } from './project-doc-snapshot.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('preserves mounted inodes across recomposition and gives changed instructions a new path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-doc-snapshot-'));
  roots.push(root);
  const source = path.join(root, 'CLAUDE.md');
  const snapshots = path.join(root, 'host-only');
  fs.writeFileSync(source, 'original instructions');
  const first = snapshotProjectDoc(source, snapshots);
  const inode = fs.statSync(first).ino;

  // Model the composer's atomic replacement while an older container is alive.
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, 'original instructions');
  fs.renameSync(replacement, source);
  expect(snapshotProjectDoc(source, snapshots)).toBe(first);
  expect(fs.statSync(first).ino).toBe(inode);
  expect(fs.statSync(first).nlink).toBe(1);

  fs.writeFileSync(replacement, 'updated instructions');
  fs.renameSync(replacement, source);
  const second = snapshotProjectDoc(source, snapshots);
  expect(second).not.toBe(first);
  expect(fs.readFileSync(second, 'utf8')).toBe('updated instructions');
  expect(fs.readFileSync(first, 'utf8')).toBe('original instructions');
  expect(fs.statSync(first).ino).toBe(inode);
  expect(fs.readdirSync(snapshots).sort()).toEqual([path.basename(first), path.basename(second)].sort());
});
