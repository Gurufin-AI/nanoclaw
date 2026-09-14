import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('watchdog thresholds, recovery, cooldown and intentional shutdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'onecli-watchdog-test-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin); mkdirSync(state);
  const fixture = (name, body) => writeFileSync(join(bin, name), '#!/bin/bash\n' + body, { mode: 0o700 });
  fixture('systemctl', 'exit "${TEST_INACTIVE:-0}"\n');
  fixture('curl', 'exit "${TEST_UNHEALTHY:-0}"\n');
  fixture('docker', `case "$1" in
info) exit "\${TEST_DOCKER_DOWN:-0}";;
inspect) echo "\${TEST_RUNNING:-true}";;
restart) printf '%s\\n' "$*" >> "$STATE_DIRECTORY/restarts";;
*) exit 99;; esac\n`);
  const run = (extra = {}) => execFileSync('bash', ['scripts/onecli-connectivity-watchdog.sh'], {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, STATE_DIRECTORY: state, ...extra }, encoding: 'utf8',
  });
  const count = () => readFileSync(join(state, 'failures'), 'utf8').trim();
  try {
    run(); assert.equal(count(), '0');
    run({ TEST_UNHEALTHY: '1' }); assert.equal(count(), '1');
    run(); assert.equal(count(), '0');
    for (let i = 0; i < 3; i++) run({ TEST_UNHEALTHY: '1' });
    assert.equal(readFileSync(join(state, 'restarts'), 'utf8'), 'restart -t 10 onecli\n');
    for (let i = 0; i < 4; i++) run({ TEST_UNHEALTHY: '1' });
    assert.equal(readFileSync(join(state, 'restarts'), 'utf8').trim().split('\n').length, 1);
    run({ TEST_INACTIVE: '1', TEST_UNHEALTHY: '1' }); assert.equal(count(), '0');
    run({ TEST_DOCKER_DOWN: '1', TEST_UNHEALTHY: '1' }); assert.equal(count(), '0');
    run({ TEST_RUNNING: 'false', TEST_UNHEALTHY: '1' }); assert.equal(count(), '0');
    assert.ok(existsSync(join(state, 'last-restart')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
