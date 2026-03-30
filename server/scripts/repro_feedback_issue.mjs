import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { createInvite as createDbInvite } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DB_PATH = process.env.SQLITE_PATH || path.join(ROOT, "server", "data", "experiment.db");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const USERS = Number(process.env.TEST_USERS || 20);
const SESSION_NUMBER = Number(process.env.TEST_SESSION || 1);
const TEST_POLL = process.env.TEST_POLL === "1";
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 180000);
const THREE_MINUTES_MS = 3 * 60 * 1000;

function openDb(dbPath) {
  return new sqlite3.Database(dbPath);
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this.changes || 0);
    });
  });
}

async function createInvite() {
  return createDbInvite({ groupAssignment: "experimental", readingOrder: "withdrawal_first" });
}

async function getSession(token) {
  const resp = await fetch(`${BASE_URL}/api/session/${token}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`getSession failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function seedEligibleChatState(db, sessionPersonaId) {
  const row = await dbGet(
    db,
    `SELECT sp.id AS sessionPersonaId, sp.participant_id AS participantId, sp.session_number AS sessionNumber
     FROM session_personas sp
     WHERE sp.id = ?`,
    [sessionPersonaId]
  );

  if (!row) {
    throw new Error(`session_persona ${sessionPersonaId} not found`);
  }

  await dbRun(
    db,
    `UPDATE session_personas
     SET first_message_at = datetime('now', '-20 minutes')
     WHERE id = ?`,
    [sessionPersonaId]
  );

  await dbRun(
    db,
    `INSERT INTO messages (participant_id, session_number, role, content, session_persona_id, conversation_id)
     VALUES (?, ?, 'user', 'hello one', ?, NULL)`,
    [row.participantId, row.sessionNumber, sessionPersonaId]
  );

  await dbRun(
    db,
    `INSERT INTO messages (participant_id, session_number, role, content, session_persona_id, conversation_id)
     VALUES (?, ?, 'user', 'hello two', ?, NULL)`,
    [row.participantId, row.sessionNumber, sessionPersonaId]
  );
}

async function requestFeedback(token, sessionPersonaId) {
  const startedAt = Date.now();
  const resp = await fetch(`${BASE_URL}/api/session/${token}/persona/${sessionPersonaId}/feedback`, {
    method: "POST"
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }

  return {
    ok: resp.ok,
    status: resp.status,
    durationMs: Date.now() - startedAt,
    payload
  };
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestFeedbackUntilReady(token, sessionPersonaId) {
  const startedAt = Date.now();
  let attempts = 0;
  let pendingCount = 0;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    attempts += 1;
    const result = await requestFeedback(token, sessionPersonaId);

    if (result.status === 202 || result.payload?.pending || result.payload?.ready === false) {
      pendingCount += 1;
      const pollAfterMs = Math.max(200, Number(result.payload?.pollAfterMs) || 2000);
      await wait(pollAfterMs);
      continue;
    }

    return {
      ...result,
      attempts,
      pendingCount,
      totalDurationMs: Date.now() - startedAt
    };
  }

  return {
    ok: false,
    status: 408,
    attempts,
    pendingCount,
    totalDurationMs: Date.now() - startedAt,
    payload: { error: "Polling timed out" }
  };
}

async function main() {
  console.log(`Running feedback stress reproduction for ${USERS} concurrent users...`);
  const db = openDb(DB_PATH);

  try {
    const cases = [];

    for (let i = 0; i < USERS; i += 1) {
      const invite = await createInvite();
      const sessionEntry = (invite.sessionTokens || []).find((s) => Number(s.sessionNumber) === SESSION_NUMBER);
      if (!sessionEntry) {
        throw new Error(`No session token for session ${SESSION_NUMBER}`);
      }

      const session = await getSession(sessionEntry.token);
      const firstChatStep = (session.steps || []).find((step) => step.type === "chat");
      if (!firstChatStep?.sessionPersonaId) {
        throw new Error("No chat persona found in session steps");
      }

      await seedEligibleChatState(db, firstChatStep.sessionPersonaId);

      cases.push({
        token: sessionEntry.token,
        sessionPersonaId: firstChatStep.sessionPersonaId
      });
    }

    const startedAt = Date.now();
    const results = await Promise.all(
      cases.map((entry) => {
        if (TEST_POLL) {
          return requestFeedbackUntilReady(entry.token, entry.sessionPersonaId);
        }
        return requestFeedback(entry.token, entry.sessionPersonaId);
      })
    );
    const totalMs = Date.now() - startedAt;

    const okCount = results.filter((r) => r.ok && r.status === 200).length;
    const errorCount = results.length - okCount;
    const byStatus = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    console.log("--- Summary ---");
    console.log(`Total requests: ${results.length}`);
    console.log(`Success: ${okCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Elapsed: ${totalMs}ms`);
    console.log(`Status breakdown: ${JSON.stringify(byStatus)}`);
    if (TEST_POLL) {
      const avgAttempts = results.reduce((sum, r) => sum + Number(r.attempts || 0), 0) / Math.max(1, results.length);
      const avgDuration = results.reduce((sum, r) => sum + Number(r.totalDurationMs || 0), 0) / Math.max(1, results.length);
      const maxDuration = results.reduce((max, r) => Math.max(max, Number(r.totalDurationMs || 0)), 0);
      const overThreeMinutes = results.filter((r) => Number(r.totalDurationMs || 0) > THREE_MINUTES_MS).length;
      const totalPendingResponses = results.reduce((sum, r) => sum + Number(r.pendingCount || 0), 0);
      console.log(`Average attempts per persona: ${avgAttempts.toFixed(2)}`);
      console.log(`Average completion time per persona: ${Math.round(avgDuration)}ms`);
      console.log(`Max completion time: ${maxDuration}ms`);
      console.log(`Users over 3 minutes: ${overThreeMinutes}`);
      console.log(`Total pending (202) responses observed: ${totalPendingResponses}`);
    }

    const sampleErrors = results.filter((r) => !r.ok).slice(0, 5).map((r) => ({
      status: r.status,
      error: r.payload?.error || null
    }));

    if (sampleErrors.length) {
      console.log("Sample errors:");
      console.log(JSON.stringify(sampleErrors, null, 2));
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
