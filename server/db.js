import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "data", "experiment.db");

let dbInstance = null;

function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createDatabase() {
  ensureDirectoryExists(DB_PATH);
  const db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_code TEXT UNIQUE NOT NULL,
        total_sessions INTEGER DEFAULT 2,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'invited'
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_id INTEGER NOT NULL,
        session_number INTEGER NOT NULL,
        session_token TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'pending',
        conversation_id TEXT,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(participant_id) REFERENCES participants(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_id INTEGER NOT NULL,
        session_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(participant_id) REFERENCES participants(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS form_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_id INTEGER NOT NULL,
        session_number INTEGER NOT NULL,
        form_key TEXT NOT NULL,
        responses_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(participant_id) REFERENCES participants(id)
      )
    `);
  });
  return db;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = createDatabase();
  }
  return dbInstance;
}

export function createInvite({ totalSessions = 2 } = {}) {
  const db = getDb();
  const participantCode = randomUUID();

  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO participants (participant_code, total_sessions) VALUES (?, ?)",
      [participantCode, totalSessions],
      function insertParticipant(err) {
        if (err) return reject(err);

        const participantId = this.lastID;
        const sessionTokens = [];
        const insertSession = db.prepare(
          "INSERT INTO sessions (participant_id, session_number, session_token) VALUES (?, ?, ?)"
        );

        for (let sessionNumber = 1; sessionNumber <= totalSessions; sessionNumber += 1) {
          const token = randomUUID();
          insertSession.run(participantId, sessionNumber, token);
          sessionTokens.push({ sessionNumber, token });
        }

        insertSession.finalize((finalizeErr) => {
          if (finalizeErr) return reject(finalizeErr);

          resolve({
            participantId,
            participantCode,
            sessionTokens
          });
        });
      }
    );
  });
}

export function listParticipants() {
  const db = getDb();
  const query = `
    SELECT p.id, p.participant_code, p.status, p.total_sessions, p.created_at,
           SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
           GROUP_CONCAT(s.session_token || ':' || s.session_number, '|') AS session_tokens
    FROM participants p
    LEFT JOIN sessions s ON s.participant_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [], (err, rows) => {
      if (err) return reject(err);

      const participants = rows.map((row) => ({
        id: row.id,
        participantCode: row.participant_code,
        status: row.status,
        createdAt: row.created_at,
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions || 0,
        sessions: (row.session_tokens || "")
          .split("|")
          .filter(Boolean)
          .map((value) => {
            const [token, sessionNumber] = value.split(":");
            return { sessionNumber: Number(sessionNumber), token };
          })
      }));

      resolve(participants);
    });
  });
}

export function getParticipantByCode(participantCode) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT id, participant_code AS participantCode, total_sessions AS totalSessions, status, created_at AS createdAt FROM participants WHERE participant_code = ?",
      [participantCode],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

export function getSessionByToken(sessionToken) {
  const db = getDb();
  const query = `
    SELECT s.id AS session_id, s.session_number, s.status AS session_status, s.conversation_id,
           s.started_at, s.completed_at, p.id AS participant_id, p.participant_code, p.total_sessions, p.status AS participant_status
    FROM sessions s
    JOIN participants p ON p.id = s.participant_id
    WHERE s.session_token = ?
    LIMIT 1
  `;

  return new Promise((resolve, reject) => {
    db.get(query, [sessionToken], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);

      resolve({
        sessionId: row.session_id,
        sessionNumber: row.session_number,
        sessionStatus: row.session_status,
        conversationId: row.conversation_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        participantId: row.participant_id,
        participantCode: row.participant_code,
        participantStatus: row.participant_status,
        totalSessions: row.total_sessions
      });
    });
  });
}

export function markSessionStarted(sessionId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE sessions SET status = 'in_progress', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?",
      [sessionId],
      function updateErr(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function markSessionCompleted(sessionId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE sessions SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?",
      [sessionId],
      function updateErr(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function saveConversationId(sessionId, conversationId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run("UPDATE sessions SET conversation_id = ? WHERE id = ?", [conversationId, sessionId], function onUpdate(err) {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

export function saveMessage({ participantId, sessionNumber, role, content }) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO messages (participant_id, session_number, role, content) VALUES (?, ?, ?, ?)",
      [participantId, sessionNumber, role, content],
      function onInsert(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

export function saveFormResponse({ participantId, sessionNumber, formKey, responses }) {
  const db = getDb();
  const payload = JSON.stringify(responses ?? {});
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO form_responses (participant_id, session_number, form_key, responses_json) VALUES (?, ?, ?, ?)",
      [participantId, sessionNumber, formKey, payload],
      function onInsert(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

export function listMessages({ participantId, sessionNumber }) {
  const db = getDb();
  const query = `
    SELECT role, content, created_at
    FROM messages
    WHERE participant_id = ? AND session_number = ?
    ORDER BY id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [participantId, sessionNumber], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function listMessagesByParticipant(participantId) {
  const db = getDb();
  const query = `
    SELECT m.session_number AS sessionNumber,
           m.role,
           m.content,
           m.created_at AS createdAt,
           s.conversation_id AS conversationId,
           s.started_at AS conversationCreatedAt
    FROM messages m
    LEFT JOIN sessions s
      ON s.participant_id = m.participant_id AND s.session_number = m.session_number
    WHERE m.participant_id = ?
    ORDER BY m.created_at ASC, m.id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [participantId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function listFormResponses({ participantId, sessionNumber }) {
  const db = getDb();
  const query = `
    SELECT form_key, responses_json, created_at
    FROM form_responses
    WHERE participant_id = ? AND session_number = ?
    ORDER BY id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [participantId, sessionNumber], (err, rows) => {
      if (err) return reject(err);
      resolve(
        (rows || []).map((row) => ({
          formKey: row.form_key,
          responses: JSON.parse(row.responses_json || "{}"),
          createdAt: row.created_at
        }))
      );
    });
  });
}

export function updateParticipantStatus(participantId, status) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run("UPDATE participants SET status = ? WHERE id = ?", [status, participantId], function onUpdate(err) {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

export function resetDatabaseForDev() {
  const db = getDb();
  db.serialize(() => {
    db.run("DELETE FROM messages");
    db.run("DELETE FROM form_responses");
    db.run("DELETE FROM sessions");
    db.run("DELETE FROM participants");
  });
}

// Initialize on import so tables exist before first request.
getDb();
