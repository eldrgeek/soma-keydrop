import assert from 'node:assert/strict';
import {
  buildAckBody,
  processQueuedAcks,
  selectQueuedAckRows,
} from '../bin/lib/keydrop-ack-sender.mjs';

function makeSupabaseFixture({ auditRows, asksById }) {
  const rows = structuredClone(auditRows || []);
  let nextId = rows.reduce((m, r) => Math.max(m, Number(r.id || 0)), 0) + 1;
  const asks = new Map(Object.entries(asksById || {}).map(([id, row]) => [id, structuredClone(row)]));

  return {
    async fetchAuditRows() {
      return structuredClone(rows);
    },
    async fetchAsksByIds(askIds) {
      const map = new Map();
      for (const askId of askIds) {
        if (asks.has(askId)) map.set(askId, structuredClone(asks.get(askId)));
      }
      return map;
    },
    async insertAuditEvent({ askId, event, detail }) {
      rows.push({
        id: nextId++,
        ask_id: askId,
        event,
        detail: detail || {},
      });
    },
    rows,
  };
}

async function testSelectionLogic() {
  assert.deepEqual(selectQueuedAckRows([]), []);

  const oneQueued = [{ id: 10, ask_id: 'ask-1', event: 'ack', detail: { mode: 'queued' } }];
  assert.deepEqual(selectQueuedAckRows(oneQueued), [
    {
      askId: 'ask-1',
      ackEventId: 10,
      attempts: 0,
      nextAttempt: 1,
      queuedDetail: { mode: 'queued' },
    },
  ]);

  const alreadySent = [
    { id: 10, ask_id: 'ask-1', event: 'ack', detail: { mode: 'queued' } },
    { id: 11, ask_id: 'ask-1', event: 'ack_sent', detail: { mode: 'mac-ack-sender' } },
  ];
  assert.deepEqual(selectQueuedAckRows(alreadySent), []);

  const failedUnderLimit = [
    { id: 10, ask_id: 'ask-1', event: 'ack', detail: { mode: 'queued' } },
    { id: 11, ask_id: 'ask-1', event: 'ack_failed', detail: { reason: 'smtp' } },
  ];
  assert.deepEqual(selectQueuedAckRows(failedUnderLimit), [
    {
      askId: 'ask-1',
      ackEventId: 10,
      attempts: 1,
      nextAttempt: 2,
      queuedDetail: { mode: 'queued' },
    },
  ]);
}

async function testIdempotency() {
  const supabase = makeSupabaseFixture({
    auditRows: [{ id: 1, ask_id: 'ask-1', event: 'ack', detail: { mode: 'queued' } }],
    asksById: {
      'ask-1': {
        id: 'ask-1',
        bound_email: 'bound@example.com',
        provider: 'stripe',
        destination: { type: 'netlify_env', site_id: 'site-1', env_key: 'STRIPE_RESTRICTED_KEY' },
        fingerprint: { provider: 'stripe', prefix: 'rk_live_xxxx…', last4: '1234', sha256: 'abc' },
      },
    },
  });

  const sends = [];
  const sendMail = async (payload) => {
    sends.push(payload);
  };
  await processQueuedAcks({ dryRun: false, supabase, sendMail, log: () => {} });
  assert.equal(sends.length, 1);
  assert.equal(supabase.rows.filter((r) => r.event === 'ack_sent').length, 1);

  await processQueuedAcks({ dryRun: false, supabase, sendMail, log: () => {} });
  assert.equal(sends.length, 1);
  assert.equal(supabase.rows.filter((r) => r.event === 'ack_sent').length, 1);
}

async function testRetryLimitAndFailure() {
  const supabase = makeSupabaseFixture({
    auditRows: [
      { id: 1, ask_id: 'ask-a', event: 'ack', detail: { mode: 'queued' } },
      { id: 2, ask_id: 'ask-a', event: 'ack_failed', detail: { reason: 't1' } },
      { id: 3, ask_id: 'ask-b', event: 'ack', detail: { mode: 'queued' } },
      { id: 4, ask_id: 'ask-b', event: 'ack_failed', detail: { reason: 't1' } },
      { id: 5, ask_id: 'ask-b', event: 'ack_failed', detail: { reason: 't2' } },
      { id: 6, ask_id: 'ask-b', event: 'ack_failed', detail: { reason: 't3' } },
      { id: 7, ask_id: 'ask-b', event: 'ack_failed', detail: { reason: 't4' } },
      { id: 8, ask_id: 'ask-b', event: 'ack_failed', detail: { reason: 't5' } },
    ],
    asksById: {
      'ask-a': {
        id: 'ask-a',
        bound_email: 'bound@example.com',
        provider: 'stripe',
        destination: { type: 'netlify_env', site_id: 'site-a', env_key: 'A' },
        fingerprint: { last4: '9999' },
      },
      'ask-b': {
        id: 'ask-b',
        bound_email: 'bound@example.com',
        provider: 'stripe',
        destination: { type: 'netlify_env', site_id: 'site-b', env_key: 'B' },
        fingerprint: { last4: '8888' },
      },
    },
  });

  let called = 0;
  const summary = await processQueuedAcks({
    dryRun: false,
    supabase,
    sendMail: async () => {
      called += 1;
      throw new Error('smtp temporary fail');
    },
    log: () => {},
  });

  assert.equal(called, 1, 'only retry-eligible ask should send once');
  assert.equal(summary.failed, 1);
  assert.equal(summary.skippedMaxRetries, 1);
  assert.equal(
    supabase.rows.filter((r) => r.ask_id === 'ask-a' && r.event === 'ack_failed').length,
    2
  );
}

async function testRedaction() {
  const body = buildAckBody({
    provider: 'stripe',
    destination: { type: 'netlify_env', site_id: 'site-1', env_key: 'STRIPE_RESTRICTED_KEY' },
    fingerprint: { prefix: 'rk_live_secretprefix…', last4: '4321', sha256: 'deadbeefcafebabe' },
  });
  assert.ok(body.includes('4321'));
  assert.ok(!body.includes('deadbeefcafebabe'));
  assert.ok(!body.includes('secretprefix'));

  const supabase = makeSupabaseFixture({
    auditRows: [{ id: 1, ask_id: 'ask-1', event: 'ack', detail: { mode: 'queued' } }],
    asksById: {
      'ask-1': {
        id: 'ask-1',
        bound_email: 'bound@example.com',
        provider: 'stripe',
        destination: { type: 'netlify_env', site_id: 'site-1', env_key: 'STRIPE_RESTRICTED_KEY' },
        fingerprint: { prefix: 'rk_live_secretprefix…', last4: '4321', sha256: 'deadbeefcafebabe' },
      },
    },
  });
  const logs = [];
  await processQueuedAcks({
    dryRun: true,
    supabase,
    sendMail: async () => {},
    log: (line) => logs.push(String(line)),
  });
  const joined = logs.join('\n');
  assert.ok(joined.includes('4321'));
  assert.ok(!joined.includes('deadbeefcafebabe'));
  assert.ok(!joined.includes('secretprefix'));
}

export async function run() {
  await testSelectionLogic();
  await testIdempotency();
  await testRetryLimitAndFailure();
  await testRedaction();
}
