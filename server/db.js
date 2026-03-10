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
        total_sessions INTEGER DEFAULT 4,
        group_assignment TEXT DEFAULT 'experimental',
        reading_order TEXT DEFAULT 'withdrawal_first',
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

    db.run(`
      CREATE TABLE IF NOT EXISTS reading_task_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_id INTEGER NOT NULL,
        session_number INTEGER NOT NULL,
        reading_key TEXT NOT NULL,
        reading_half TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        question_prompt TEXT,
        answer_text TEXT,
        answer_json TEXT,
        answered_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(participant_id) REFERENCES participants(id)
      )
    `);
  });

  // Lightweight migrations for existing databases
  db.serialize(() => {
    ensureColumnExists(db, "participants", "group_assignment", "TEXT DEFAULT 'experimental'").catch((err) =>
      console.error("Failed to add group_assignment column", err)
    );
    ensureColumnExists(db, "participants", "reading_order", "TEXT DEFAULT 'withdrawal_first'").catch((err) =>
      console.error("Failed to add reading_order column", err)
    );
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

export function createInvite({ groupAssignment = "experimental", readingOrder = "withdrawal_first" } = {}) {
  const db = getDb();
  const participantCode = randomUUID();
  const totalSessions = 4;
  const normalizedGroup = groupAssignment === "control" ? "control" : "experimental";
  const normalizedReadingOrder = readingOrder === "confrontation_first"
    ? "confrontation_first"
    : "withdrawal_first";

  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO participants (participant_code, total_sessions, group_assignment, reading_order) VALUES (?, ?, ?, ?)",
      [participantCode, totalSessions, normalizedGroup, normalizedReadingOrder],
      function insertParticipant(err) {
        if (err) return reject(err);

        const participantId = this.lastID;
        const sessionTokens = [];
        const insertSession = db.prepare(
          "INSERT INTO sessions (participant_id, session_number, session_token) VALUES (?, ?, ?)"
        );

        for (let n = 1; n <= totalSessions; n += 1) {
          const token = randomUUID();
          insertSession.run(participantId, n, token);
          sessionTokens.push({ sessionNumber: n, token });
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
    SELECT p.id AS participant_id,
      p.participant_code,
      p.status,
      p.total_sessions,
      p.group_assignment,
      p.reading_order,
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
            groupAssignment: row.group_assignment,
            readingOrder: row.reading_order,
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
      "SELECT id, participant_code AS participantCode, total_sessions AS totalSessions, status, group_assignment AS groupAssignment, reading_order AS readingOrder, created_at AS createdAt FROM participants WHERE participant_code = ?",
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
          s.started_at, s.completed_at, p.id AS participant_id, p.participant_code, p.total_sessions, p.status AS participant_status,
          p.group_assignment, p.reading_order
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
        totalSessions: row.total_sessions,
        groupAssignment: row.group_assignment,
        readingOrder: row.reading_order
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
    const deleteSql = `DELETE FROM form_responses WHERE participant_id = ? AND session_number = ? AND form_key = ? AND IFNULL(session_persona_id, -1) = IFNULL(?, -1)`;
    db.serialize(() => {
      db.run(deleteSql, [participantId, sessionNumber, formKey, sessionPersonaId], (delErr) => {
        if (delErr) return reject(delErr);
        db.run(
          "INSERT INTO form_responses (participant_id, session_number, form_key, responses_json, session_persona_id) VALUES (?, ?, ?, ?, ?)",
          [participantId, sessionNumber, formKey, payload, sessionPersonaId],
          function onInsert(err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      });
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

export function saveReadingTaskResponse({
  participantId,
  sessionNumber,
  readingKey,
  readingHalf,
  chunkIndex,
  questionId,
  questionPrompt,
  answer
}) {
  const db = getDb();
  const answerText = answer == null ? "" : String(answer);
  const answerJson = JSON.stringify({ value: answer });

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `DELETE FROM reading_task_responses
         WHERE participant_id = ?
           AND session_number = ?
           AND reading_key = ?
           AND reading_half = ?
           AND chunk_index = ?
           AND question_id = ?`,
        [participantId, sessionNumber, readingKey, readingHalf, chunkIndex, questionId],
        (deleteErr) => {
          if (deleteErr) return reject(deleteErr);

          db.run(
            `INSERT INTO reading_task_responses
            (participant_id, session_number, reading_key, reading_half, chunk_index, question_id, question_prompt, answer_text, answer_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              participantId,
              sessionNumber,
              readingKey,
              readingHalf,
              chunkIndex,
              questionId,
              questionPrompt || null,
              answerText,
              answerJson
            ],
            function onInsert(err) {
              if (err) return reject(err);
              resolve(this.lastID);
            }
          );
        }
      );
    });
  });
}

export function listReadingTaskResponses({ participantId, sessionNumber, readingKey, readingHalf }) {
  const db = getDb();
  const query = `
    SELECT id,
           participant_id AS participantId,
           session_number AS sessionNumber,
           reading_key AS readingKey,
           reading_half AS readingHalf,
           chunk_index AS chunkIndex,
           question_id AS questionId,
           question_prompt AS questionPrompt,
           answer_text AS answerText,
           answer_json AS answerJson,
           answered_at AS answeredAt
    FROM reading_task_responses
    WHERE participant_id = ?
      AND session_number = ?
      AND reading_key = ?
      AND reading_half = ?
    ORDER BY chunk_index ASC, id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [participantId, sessionNumber, readingKey, readingHalf], (err, rows) => {
      if (err) return reject(err);
      resolve(
        (rows || []).map((row) => {
          let parsed = null;
          try {
            parsed = JSON.parse(row.answerJson || "null");
          } catch (e) {
            parsed = null;
          }
          return {
            id: row.id,
            participantId: row.participantId,
            sessionNumber: row.sessionNumber,
            readingKey: row.readingKey,
            readingHalf: row.readingHalf,
            chunkIndex: row.chunkIndex,
            questionId: row.questionId,
            questionPrompt: row.questionPrompt,
            answerText: row.answerText,
            answer: parsed?.value ?? row.answerText,
            answeredAt: row.answeredAt
          };
        })
      );
    });
  });
}

export function resetSessionByToken(sessionToken) {
  const db = getDb();

  const runSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

  const getSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });

  const allSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });

  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        const session = await getSql(
          `SELECT s.id AS sessionId,
                  s.participant_id AS participantId,
                  s.session_number AS sessionNumber,
                  p.participant_code AS participantCode
           FROM sessions s
           JOIN participants p ON p.id = s.participant_id
           WHERE s.session_token = ?
           LIMIT 1`,
          [sessionToken]
        );

        if (!session) {
          resolve(null);
          return;
        }

        await runSql("BEGIN TRANSACTION");
        await runSql(
          `UPDATE sessions
           SET status = 'pending', conversation_id = NULL, started_at = NULL, completed_at = NULL
           WHERE id = ?`,
          [session.sessionId]
        );
        await runSql(
          "DELETE FROM messages WHERE participant_id = ? AND session_number = ?",
          [session.participantId, session.sessionNumber]
        );
        await runSql(
          "DELETE FROM form_responses WHERE participant_id = ? AND session_number = ?",
          [session.participantId, session.sessionNumber]
        );
        await runSql(
          "DELETE FROM reading_task_responses WHERE participant_id = ? AND session_number = ?",
          [session.participantId, session.sessionNumber]
        );
        await runSql("DELETE FROM session_personas WHERE session_id = ?", [session.sessionId]);

        const participantSessions = await allSql(
          `SELECT status,
                  started_at AS startedAt,
                  completed_at AS completedAt
           FROM sessions
           WHERE participant_id = ?`,
          [session.participantId]
        );

        const hasStartedAny = participantSessions.some((row) => Boolean(row.startedAt));
        const allCompleted = participantSessions.length > 0
          && participantSessions.every((row) => row.status === "completed" || Boolean(row.completedAt));
        const participantStatus = allCompleted ? "completed" : hasStartedAny ? "in_progress" : "invited";

        await runSql("UPDATE participants SET status = ? WHERE id = ?", [participantStatus, session.participantId]);
        await runSql("COMMIT");

        resolve({
          sessionId: session.sessionId,
          sessionNumber: session.sessionNumber,
          participantCode: session.participantCode,
          participantId: session.participantId,
          participantStatus
        });
      } catch (error) {
        try {
          await runSql("ROLLBACK");
        } catch (_rollbackError) {
        }
        reject(error);
      }
    });
  });
}

export function resetDatabaseForDev() {
  const db = getDb();
  db.serialize(() => {
    db.run("DELETE FROM messages");
    db.run("DELETE FROM form_responses");
    db.run("DELETE FROM reading_task_responses");
    db.run("DELETE FROM sessions");
    db.run("DELETE FROM participants");
  });
}

// Initialize on import so tables exist before first request.
getDb();
