import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ACK_SUBJECT = 'KeyDrop: your key was received';
export const MAX_RETRY_ATTEMPTS = 5;
const MIKE_EMAIL = 'mw@mike-wolf.com';

export class ConfigError extends Error {}

export function mergeEnvFromDotEnv(baseDir, env = process.env) {
  const merged = { ...env };
  const dotEnvPath = path.join(baseDir, '.env');
  let raw = '';
  try {
    raw = fs.readFileSync(dotEnvPath, 'utf8');
  } catch {
    return merged;
  }

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, ...rest] = t.split('=');
    if (!k) continue;
    if (merged[k] !== undefined && merged[k] !== '') continue;
    merged[k] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  return merged;
}

export function getSenderConfig({ baseDir, env = process.env } = {}) {
  if (!baseDir) throw new ConfigError('baseDir is required');
  const merged = mergeEnvFromDotEnv(baseDir, env);

  const supabaseUrl = merged.SUPABASE_URL;
  const supabaseServiceKey = merged.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new ConfigError('missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }

  const mailScript =
    merged.KEYDROP_ACK_MAIL_SCRIPT ||
    path.join(merged.HOME || '', 'Projects', 'SOMA', 'tools', 'mail', 'send_from_claude.py');
  if (!mailScript) throw new ConfigError('mail script path is empty');
  if (!fs.existsSync(mailScript)) {
    throw new ConfigError(`mail script not found: ${mailScript}`);
  }

  return {
    supabaseUrl,
    supabaseServiceKey,
    mailScript,
    pythonBin: merged.KEYDROP_ACK_PYTHON_BIN || 'python3',
    seat: merged.ESTATE_SEAT || 'cursor-worker',
  };
}

export function selectQueuedAckRows(auditRows, { maxFailures = MAX_RETRY_ATTEMPTS } = {}) {
  const queuedByAsk = new Map();
  const latestSentIdByAsk = new Map();
  const failedRowsByAsk = new Map();

  for (const row of auditRows || []) {
    const askId = row.ask_id;
    const event = row.event || row.action;
    if (!askId || !event) continue;

    if (event === 'ack' && row.detail && row.detail.mode === 'queued') {
      queuedByAsk.set(askId, row);
      continue;
    }

    if (event === 'ack_sent') {
      latestSentIdByAsk.set(askId, row.id);
      continue;
    }

    if (event === 'ack_failed') {
      if (!failedRowsByAsk.has(askId)) failedRowsByAsk.set(askId, []);
      failedRowsByAsk.get(askId).push(row);
    }
  }

  const work = [];
  for (const [askId, ackRow] of queuedByAsk.entries()) {
    const ackId = Number(ackRow.id || 0);
    const latestSentId = Number(latestSentIdByAsk.get(askId) || 0);
    if (latestSentId > ackId) continue;

    const failedRows = failedRowsByAsk.get(askId) || [];
    const failuresSinceQueued = failedRows.filter((f) => Number(f.id || 0) > ackId).length;
    if (failuresSinceQueued >= maxFailures) continue;

    work.push({
      askId,
      ackEventId: ackId,
      attempts: failuresSinceQueued,
      nextAttempt: failuresSinceQueued + 1,
      queuedDetail: ackRow.detail || {},
    });
  }

  work.sort((a, b) => a.ackEventId - b.ackEventId);
  return work;
}

export function formatDestination(destination) {
  if (!destination || typeof destination !== 'object') return 'the configured destination';
  const type = String(destination.type || 'destination');
  const site = destination.site_id ? `site ${destination.site_id}` : 'unknown site';
  const envKey = destination.env_key ? `env ${destination.env_key}` : 'unknown env key';
  return `${type} (${site}, ${envKey})`;
}

export function buildAckBody({ provider, destination, fingerprint }) {
  const providerName = String(provider || 'provider');
  const last4 =
    fingerprint && typeof fingerprint === 'object' && fingerprint.last4 ? String(fingerprint.last4) : null;
  const keySuffixLine = last4
    ? `Reference fingerprint suffix: ${last4}`
    : 'Reference fingerprint suffix: unavailable';
  return [
    'Hi,',
    '',
    `Your ${providerName} key was received.`,
    `Destination: ${formatDestination(destination)}.`,
    keySuffixLine,
    '',
    'If anything looks wrong, reply to this message so we can investigate.',
    '',
    '— Dee (SOMA KeyDrop)',
  ].join('\n');
}

export function redactAskId(askId) {
  const v = String(askId || '');
  return v.length > 8 ? `${v.slice(0, 8)}…` : v || 'unknown';
}

function recipientPair(boundEmail) {
  const to = String(boundEmail || '').trim();
  if (!to) return { to: MIKE_EMAIL, cc: null, recipients: [MIKE_EMAIL] };
  if (to.toLowerCase() === MIKE_EMAIL) return { to, cc: null, recipients: [to] };
  return { to, cc: MIKE_EMAIL, recipients: [to, MIKE_EMAIL] };
}

function shortFailureReason(err) {
  const msg = err && err.message ? String(err.message) : 'send failed';
  return msg.replace(/\s+/g, ' ').slice(0, 120);
}

export async function processQueuedAcks({
  dryRun = false,
  supabase,
  sendMail,
  log = () => {},
  maxAttempts = MAX_RETRY_ATTEMPTS,
} = {}) {
  if (!supabase) throw new Error('supabase client is required');
  if (!dryRun && typeof sendMail !== 'function') throw new Error('sendMail is required');

  const summary = {
    queued: 0,
    sent: 0,
    failed: 0,
    skippedMissingAsk: 0,
    skippedMaxRetries: 0,
  };

  const auditRows = await supabase.fetchAuditRows();
  const allQueued = selectQueuedAckRows(auditRows, { maxFailures: Number.MAX_SAFE_INTEGER });
  const retryable = selectQueuedAckRows(auditRows, { maxFailures: maxAttempts });
  summary.queued = retryable.length;
  summary.skippedMaxRetries = allQueued.length - retryable.length;
  if (retryable.length === 0) {
    log('No queued ack rows are ready for send.');
    return summary;
  }

  const asksById = await supabase.fetchAsksByIds(retryable.map((x) => x.askId));
  for (const work of retryable) {
    const ask = asksById.get(work.askId);
    if (!ask) {
      summary.skippedMissingAsk += 1;
      log(`ask ${redactAskId(work.askId)} skipped: ask row missing`);
      continue;
    }

    const recipients = recipientPair(ask.bound_email);
    const body = buildAckBody({
      provider: ask.provider,
      destination: ask.destination,
      fingerprint: ask.fingerprint,
    });

    if (dryRun) {
      const last4 = ask.fingerprint && ask.fingerprint.last4 ? String(ask.fingerprint.last4) : 'n/a';
      log(
        `[dry-run] ask ${redactAskId(work.askId)} -> to=${recipients.to}` +
          `${recipients.cc ? ` cc=${recipients.cc}` : ''}; provider=${ask.provider};` +
          ` destination=${formatDestination(ask.destination)}; last4=${last4}`
      );
      continue;
    }

    try {
      await sendMail({
        to: recipients.to,
        cc: recipients.cc,
        subject: ACK_SUBJECT,
        body,
      });
      await supabase.insertAuditEvent({
        askId: work.askId,
        event: 'ack_sent',
        detail: {
          mode: 'mac-ack-sender',
          to: recipients.recipients,
          attempt: work.nextAttempt,
        },
      });
      summary.sent += 1;
      log(`sent ack for ask ${redactAskId(work.askId)} (attempt ${work.nextAttempt})`);
    } catch (err) {
      await supabase.insertAuditEvent({
        askId: work.askId,
        event: 'ack_failed',
        detail: {
          mode: 'mac-ack-sender',
          attempt: work.nextAttempt,
          reason: shortFailureReason(err),
        },
      });
      summary.failed += 1;
      log(`ack failed for ask ${redactAskId(work.askId)} (attempt ${work.nextAttempt})`);
    }
  }

  return summary;
}

export function createSupabaseClient({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  if (!supabaseUrl || !serviceKey) throw new ConfigError('missing Supabase config');

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  async function rest(pathWithQuery, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${supabaseUrl}/rest/v1/${pathWithQuery}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Supabase ${method} ${pathWithQuery} failed (${response.status})`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : [];
  }

  return {
    async fetchAuditRows() {
      return rest('keydrop_audit?select=id,ask_id,event,detail&event=in.(ack,ack_sent,ack_failed)&order=id.asc');
    },
    async fetchAsksByIds(askIds) {
      const map = new Map();
      const uniqueIds = Array.from(new Set((askIds || []).filter(Boolean)));
      if (uniqueIds.length === 0) return map;

      const chunkSize = 100;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const rows = await rest(
          `keydrop_asks?select=id,bound_email,provider,destination,fingerprint&id=in.(${chunk.join(',')})`
        );
        for (const row of rows || []) map.set(row.id, row);
      }
      return map;
    },
    async insertAuditEvent({ askId, event, detail }) {
      await rest('keydrop_audit', {
        method: 'POST',
        body: { ask_id: askId, event, detail: detail || {} },
      });
    },
  };
}

export async function sendViaClaudeMail({
  pythonBin = 'python3',
  mailScript,
  to,
  cc,
  subject,
  body,
  seat = 'cursor-worker',
  runCommand = runCommandDefault,
} = {}) {
  if (!mailScript) throw new ConfigError('missing mail script path');
  if (!to) throw new Error('missing recipient email');
  if (!subject) throw new Error('missing subject');

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'keydrop-ack-'));
  const bodyPath = path.join(tmpDir, 'body.txt');
  try {
    await writeFile(bodyPath, body || '', 'utf8');
    const args = [mailScript, '--to', to, '--subject', subject, '--body-file', bodyPath, '--seat', seat];
    if (cc) args.push('--cc', cc);
    const result = await runCommand(pythonBin, args);
    if (result.code !== 0) throw new Error(`mail command exit ${result.code}`);
    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export function runCommandDefault(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}
