import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "data", "experiment.db");

let dbInstance = null;

function ensureColumnExists(db, table, column, definition) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
      if (err) return reject(err);
      const exists = (rows || []).some((row) => row.name === column);
      if (exists) return resolve(true);

      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, [], (alterErr) => {
        if (alterErr) return reject(alterErr);
        resolve(true);
      });
    });
  });
}

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
        session_persona_id INTEGER,
        conversation_id TEXT,
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
        session_persona_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(participant_id) REFERENCES participants(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS session_personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        participant_id INTEGER NOT NULL,
        session_number INTEGER NOT NULL,
        persona_csv_id INTEGER NOT NULL,
        persona_order INTEGER NOT NULL,
        persona_name TEXT NOT NULL,
        persona_json TEXT NOT NULL,
        conversation_id TEXT,
        first_message_at TEXT,
        mid_prompt_sent INTEGER DEFAULT 0,
        feedback_prompt_sent INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(participant_id) REFERENCES participants(id)
      )
    `);
  });

  // Lightweight migrations for existing databases
  db.serialize(() => {
    ensureColumnExists(db, "messages", "session_persona_id", "INTEGER").catch((err) =>
      console.error("Failed to add session_persona_id column", err)
    );
    ensureColumnExists(db, "messages", "conversation_id", "TEXT").catch((err) =>
      console.error("Failed to add conversation_id column", err)
    );
    ensureColumnExists(db, "form_responses", "session_persona_id", "INTEGER").catch((err) =>
      console.error("Failed to add session_persona_id column to form_responses", err)
    );
  });
  return db;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = createDatabase();
  }
  return dbInstance;
}

export function createInvite({ sessionNumber = 1 } = {}) {
  const db = getDb();
  const participantCode = randomUUID();
  const totalSessions = 1;
  const targetSessionNumber = Number(sessionNumber) || 1;

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

        const token = randomUUID();
        insertSession.run(participantId, targetSessionNumber, token);
        sessionTokens.push({ sessionNumber: targetSessionNumber, token });

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
    SELECT p.id AS participant_id,
      p.participant_code,
      p.status,
      p.total_sessions,
      p.created_at,
      s.id AS session_id,
      s.session_number,
      s.session_token,
      s.status AS session_status,
      s.started_at,
      s.completed_at
    FROM participants p
    LEFT JOIN sessions s ON s.participant_id = p.id
    ORDER BY p.created_at DESC, s.session_number ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [], (err, rows) => {
      if (err) return reject(err);

      const participantsById = new Map();
      rows.forEach((row) => {
        if (!participantsById.has(row.participant_id)) {
          participantsById.set(row.participant_id, {
            id: row.participant_id,
            participantCode: row.participant_code,
            status: row.status,
            createdAt: row.created_at,
            totalSessions: row.total_sessions,
            completedSessions: 0,
            sessions: []
          });
        }

        if (row.session_id) {
          const participant = participantsById.get(row.participant_id);
          const sessionStatus = row.session_status || "pending";
          if (sessionStatus === "completed") {
            participant.completedSessions += 1;
          }
          participant.sessions.push({
            sessionId: row.session_id,
            sessionNumber: row.session_number,
            token: row.session_token,
            status: sessionStatus,
            startedAt: row.started_at,
            completedAt: row.completed_at
          });
        }
      });

      resolve(Array.from(participantsById.values()));
    });
  });
}

export function listSessionsByParticipant(participantId) {
  const db = getDb();
  const query = `
    SELECT id AS sessionId,
           session_number AS sessionNumber,
           status,
           started_at AS startedAt,
           completed_at AS completedAt
    FROM sessions
    WHERE participant_id = ?
    ORDER BY session_number ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [participantId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
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
      "INSERT INTO messages (participant_id, session_number, role, content, session_persona_id, conversation_id) VALUES (?, ?, ?, ?, ?, ?)",
      [participantId, sessionNumber, role, content, null, null],
      function onInsert(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

export function savePersonaMessage({ participantId, sessionNumber, role, content, sessionPersonaId, conversationId }) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO messages (participant_id, session_number, role, content, session_persona_id, conversation_id) VALUES (?, ?, ?, ?, ?, ?)",
      [participantId, sessionNumber, role, content, sessionPersonaId || null, conversationId || null],
      function onInsert(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

export function saveFormResponse({ participantId, sessionNumber, formKey, responses, sessionPersonaId = null }) {
  const db = getDb();
  const payload = JSON.stringify(responses ?? {});
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO form_responses (participant_id, session_number, form_key, responses_json, session_persona_id) VALUES (?, ?, ?, ?, ?)",
      [participantId, sessionNumber, formKey, payload, sessionPersonaId],
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

export function listMessagesBySessionPersona(sessionPersonaId) {
  const db = getDb();
  const query = `
    SELECT role, content, created_at
    FROM messages
    WHERE session_persona_id = ?
    ORDER BY id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [sessionPersonaId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function createSessionPersonas({ sessionId, participantId, sessionNumber, personas }) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(
      `INSERT INTO session_personas (session_id, participant_id, session_number, persona_csv_id, persona_order, persona_name, persona_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const created = [];
    personas.forEach((persona) => {
      stmt.run(
        sessionId,
        participantId,
        sessionNumber,
        persona.personaCsvId,
        persona.order,
        persona.name,
        JSON.stringify(persona.data || {}),
        function onInsert(err) {
          if (err) return reject(err);
          created.push({ id: this.lastID, ...persona });
        }
      );
    });
    stmt.finalize((err) => {
      if (err) return reject(err);
      resolve(created);
    });
  });
}

export function getSessionPersonas(sessionId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, session_id AS sessionId, participant_id AS participantId, session_number AS sessionNumber, persona_csv_id AS personaCsvId, persona_order AS personaOrder, persona_name AS personaName, persona_json AS personaJson, conversation_id AS conversationId, first_message_at AS firstMessageAt, mid_prompt_sent AS midPromptSent, feedback_prompt_sent AS feedbackPromptSent
       FROM session_personas
       WHERE session_id = ?
       ORDER BY persona_order ASC`,
      [sessionId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

export function getSessionPersona(sessionPersonaId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, session_id AS sessionId, participant_id AS participantId, session_number AS sessionNumber, persona_csv_id AS personaCsvId, persona_order AS personaOrder, persona_name AS personaName, persona_json AS personaJson, conversation_id AS conversationId, first_message_at AS firstMessageAt, mid_prompt_sent AS midPromptSent, feedback_prompt_sent AS feedbackPromptSent
       FROM session_personas
       WHERE id = ?
       LIMIT 1`,
      [sessionPersonaId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

export function saveSessionPersonaConversationId(sessionPersonaId, conversationId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE session_personas SET conversation_id = ? WHERE id = ?",
      [conversationId, sessionPersonaId],
      function onUpdate(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function markSessionPersonaFirstMessage(sessionPersonaId, timestampIso) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE session_personas SET first_message_at = COALESCE(first_message_at, ?) WHERE id = ?",
      [timestampIso, sessionPersonaId],
      function onUpdate(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function markSessionPersonaMidPromptSent(sessionPersonaId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE session_personas SET mid_prompt_sent = 1 WHERE id = ?",
      [sessionPersonaId],
      function onUpdate(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function markSessionPersonaFeedbackSent(sessionPersonaId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE session_personas SET feedback_prompt_sent = 1 WHERE id = ?",
      [sessionPersonaId],
      function onUpdate(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
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
    SELECT form_key, responses_json, session_persona_id, created_at
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
          sessionPersonaId: row.session_persona_id,
          createdAt: row.created_at
        }))
      );
    });
  });
}

export function listAllFormResponses({ formKey } = {}) {
  const db = getDb();
  const params = [];
  const where = formKey ? "WHERE fr.form_key = ?" : "";
  if (formKey) params.push(formKey);

  const query = `
    SELECT fr.id,
           fr.participant_id AS participantId,
           fr.session_number AS sessionNumber,
           fr.form_key AS formKey,
           fr.responses_json AS responsesJson,
           fr.session_persona_id AS sessionPersonaId,
           fr.created_at AS createdAt,
           p.participant_code AS participantCode,
           sp.persona_name AS personaName,
           sp.persona_csv_id AS personaCsvId
    FROM form_responses fr
    JOIN participants p ON p.id = fr.participant_id
    LEFT JOIN session_personas sp ON sp.id = fr.session_persona_id
    ${where}
    ORDER BY fr.created_at DESC, fr.id DESC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      const safeRows = (rows || []).map((row) => {
        let parsedResponses = {};
        try {
          parsedResponses = JSON.parse(row.responsesJson || "{}");
        } catch (parseErr) {
          parsedResponses = { _parse_error: parseErr.message };
        }
        return {
          id: row.id,
          participantId: row.participantId,
          participantCode: row.participantCode,
          sessionNumber: row.sessionNumber,
          formKey: row.formKey,
          responses: parsedResponses,
          sessionPersonaId: row.sessionPersonaId,
          personaName: row.personaName || null,
          personaCsvId: row.personaCsvId || null,
          createdAt: row.createdAt
        };
      });
      resolve(safeRows);
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
