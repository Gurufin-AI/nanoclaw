/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addReaction, editMessage, sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('platform message IDs for reactions and edits', () => {
  function seedInbound(content: string, kind = 'chat-sdk'): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, platform_id, content)
       VALUES (?, 2, ?, ?, 'telegram', 'telegram:12345', ?)`,
      )
      .run('12345:678:ag-test', kind, new Date().toISOString(), content);
  }

  it('queues a reaction using the original Chat SDK ID, not the router ID', async () => {
    seedInbound(JSON.stringify({ _type: 'chat:Message', id: '12345:678', text: 'hello' }));
    await addReaction.handler({ messageId: 2, emoji: 'thumbs_up' });
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toMatchObject({ operation: 'reaction', messageId: '12345:678' });
  });

  it('uses the same platform ID resolution for edits', async () => {
    seedInbound(JSON.stringify({ _type: 'chat:Message', id: '12345:678' }));
    await editMessage.handler({ messageId: 2, text: 'updated' });
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toMatchObject({
      operation: 'edit',
      messageId: '12345:678',
      text: 'updated',
    });
  });

  for (const content of ['{broken', '{}', 'null', '{"_type":"chat:Message","id":""}']) {
    it(`does not queue a reaction with a missing/invalid platform ID: ${content}`, async () => {
      seedInbound(content);
      await addReaction.handler({ messageId: 2, emoji: 'thumbs_up' });
      expect(getUndeliveredMessages()).toHaveLength(0);
    });
  }

  it('does not use an internal outbound ID before delivery', async () => {
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, seq, kind, timestamp, channel_type, platform_id, content)
       VALUES ('internal-out', 3, 'chat', ?, 'telegram', 'telegram:12345', '{}')`,
      )
      .run(new Date().toISOString());
    await addReaction.handler({ messageId: 3, emoji: 'thumbs_up' });
    expect(getUndeliveredMessages()).toHaveLength(1);
    getInboundDb()
      .prepare('INSERT INTO delivered (message_out_id, platform_message_id, delivered_at) VALUES (?, ?, ?)')
      .run('internal-out', '12345:679', new Date().toISOString());
    await addReaction.handler({ messageId: 3, emoji: 'thumbs_up' });
    const reaction = getUndeliveredMessages().find((m) => JSON.parse(m.content).operation === 'reaction');
    expect(reaction).toBeDefined();
    expect(JSON.parse(reaction!.content).messageId).toBe('12345:679');
  });
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});
