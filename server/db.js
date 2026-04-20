import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { nowGmtPlus3Iso, toGmtPlus3Iso } from "./utils/timezone.js";

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

function computeSessionScheduledFor(scheduleStart, sessionNumber) {
  if (!scheduleStart) return null;
  const base = new Date(scheduleStart);
  if (Number.isNaN(base.getTime())) return null;
  const offsetDays = Math.max(0, Number(sessionNumber) - 1) * 7;
  return toGmtPlus3Iso(new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000));
}

function syncSessionSchedulesForParticipant(db, participantId, scheduleStart) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT id, session_number FROM sessions WHERE participant_id = ? ORDER BY session_number ASC",
      [participantId],
      (selectErr, rows) => {
        if (selectErr) return reject(selectErr);

        const sessions = rows || [];
        if (!sessions.length) return resolve(true);

        const stmt = db.prepare("UPDATE sessions SET scheduled_for = ? WHERE id = ?");
        let pending = sessions.length;
        let failed = false;

        sessions.forEach((row) => {
          const scheduledFor = computeSessionScheduledFor(scheduleStart, row.session_number);
          stmt.run([scheduledFor, row.id], (updateErr) => {
            if (failed) return;
            if (updateErr) {
              failed = true;
              stmt.finalize(() => reject(updateErr));
              return;
            }

            pending -= 1;
            if (pending === 0) {
              stmt.finalize((finalizeErr) => {
                if (finalizeErr) return reject(finalizeErr);
                resolve(true);
              });
            }
          });
        });
      }
    );
  });
}

function createDatabase() {
  ensureDirectoryExists(DB_PATH);
  const db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_code TEXT UNIQUE NOT NULL,
        subject_id TEXT,
        schedule_start TEXT,
        notes TEXT,
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
        scheduled_for TEXT,
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
      CREATE TABLE IF NOT EXISTS module_question_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        session_number INTEGER NOT NULL,
        module_name TEXT NOT NULL,
        section_id TEXT NOT NULL,
        section_number INTEGER,
        question_id TEXT NOT NULL,
        question_number INTEGER,
        question_content TEXT,
        answer TEXT,
        correct_answer TEXT,
        is_correct INTEGER,
        timedate TEXT DEFAULT CURRENT_TIMESTAMP,
        time_since_start REAL,
        FOREIGN KEY(participant_id) REFERENCES participants(id),
        FOREIGN KEY(session_id) REFERENCES sessions(id)
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
    ensureColumnExists(db, "participants", "subject_id", "TEXT").catch((err) =>
      console.error("Failed to add subject_id column", err)
    );
    ensureColumnExists(db, "participants", "schedule_start", "TEXT").catch((err) =>
      console.error("Failed to add schedule_start column", err)
    );
    ensureColumnExists(db, "participants", "notes", "TEXT").catch((err) =>
      console.error("Failed to add notes column", err)
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
    ensureColumnExists(db, "sessions", "scheduled_for", "TEXT")
      .then(() => {
        db.all(
          "SELECT id, schedule_start FROM participants",
          [],
          (selectErr, participants) => {
            if (selectErr) {
              console.error("Failed to load participants for schedule backfill", selectErr);
              return;
            }

            (participants || []).forEach((participant) => {
              syncSessionSchedulesForParticipant(db, participant.id, participant.schedule_start).catch((err) =>
                console.error(`Failed to backfill session schedule for participant ${participant.id}`, err)
              );
            });
          }
        );
      })
      .catch((err) => console.error("Failed to add scheduled_for column", err));
    ensureColumnExists(db, "sessions", "schedule_lock_disabled", "INTEGER DEFAULT 0").catch((err) =>
      console.error("Failed to add schedule_lock_disabled column", err)
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
  const createdAt = nowGmtPlus3Iso();
  const normalizedGroup = groupAssignment === "control" ? "control" : "experimental";
  const normalizedReadingOrder = readingOrder === "confrontation_first"
    ? "confrontation_first"
    : "withdrawal_first";

  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO participants (participant_code, total_sessions, group_assignment, reading_order, created_at) VALUES (?, ?, ?, ?, ?)",
      [participantCode, totalSessions, normalizedGroup, normalizedReadingOrder, createdAt],
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
      p.schedule_start,
      p.subject_id,
      p.notes,
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
      s.scheduled_for,
      s.schedule_lock_disabled,
      s.started_at,
      s.completed_at,
      consent.consent_completed_at,
      personas.persona_names
    FROM participants p
    LEFT JOIN sessions s ON s.participant_id = p.id
    LEFT JOIN (
      SELECT participant_id, session_number, MAX(created_at) AS consent_completed_at
      FROM form_responses
      WHERE form_key = 'consent'
      GROUP BY participant_id, session_number
    ) consent
      ON consent.participant_id = s.participant_id
      AND consent.session_number = s.session_number
    LEFT JOIN (
      SELECT session_id, GROUP_CONCAT(persona_name, ' | ') AS persona_names
      FROM session_personas
      GROUP BY session_id
    ) personas
      ON personas.session_id = s.id
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
              subjectId: row.subject_id || null,
              scheduleStart: row.schedule_start || null,
            notes: row.notes || null,
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
            scheduledFor: row.scheduled_for || null,
            scheduleLockDisabled: Boolean(Number(row.schedule_lock_disabled) || 0),
            startedAt: row.started_at,
            completedAt: row.completed_at,
            consentCompletedAt: row.consent_completed_at,
            personaNames: row.persona_names || ""
          });
        }
      });

      resolve(Array.from(participantsById.values()));
    });
  });
}

export function updateParticipantMetadata(participantId, { subjectId = null, notes = null, scheduleStart = null } = {}) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE participants SET subject_id = ?, notes = ?, schedule_start = ? WHERE id = ?",
      [subjectId, notes, scheduleStart, participantId],
      async function onUpdate(err) {
        if (err) return reject(err);
        try {
          await syncSessionSchedulesForParticipant(db, participantId, scheduleStart);
          resolve(true);
        } catch (syncErr) {
          reject(syncErr);
        }
      }
    );
  });
}

export function listSessionsByParticipant(participantId) {
  const db = getDb();
  const query = `
      SELECT s.id AS sessionId,
        s.session_number AS sessionNumber,
        s.status AS status,
        s.scheduled_for AS scheduledFor,
        s.schedule_lock_disabled AS scheduleLockDisabled,
        s.started_at AS startedAt,
        s.completed_at AS completedAt,
           consent.consent_completed_at AS consentCompletedAt,
           personas.persona_names AS personaNames
    FROM sessions s
    LEFT JOIN (
      SELECT participant_id, session_number, MAX(created_at) AS consent_completed_at
      FROM form_responses
      WHERE form_key = 'consent'
      GROUP BY participant_id, session_number
    ) consent
      ON consent.participant_id = s.participant_id
      AND consent.session_number = s.session_number
    LEFT JOIN (
      SELECT session_id, GROUP_CONCAT(persona_name, ' | ') AS persona_names
      FROM session_personas
      GROUP BY session_id
    ) personas
      ON personas.session_id = s.id
    WHERE s.participant_id = ?
    ORDER BY s.session_number ASC
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
      "SELECT id, participant_code AS participantCode, total_sessions AS totalSessions, status, group_assignment AS groupAssignment, reading_order AS readingOrder, schedule_start AS scheduleStart, created_at AS createdAt FROM participants WHERE participant_code = ?",
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
          s.scheduled_for, s.schedule_lock_disabled, s.started_at, s.completed_at, p.id AS participant_id, p.participant_code, p.total_sessions, p.status AS participant_status,
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
        scheduledFor: row.scheduled_for || null,
        scheduleLockDisabled: Boolean(Number(row.schedule_lock_disabled) || 0),
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
  const startedAt = nowGmtPlus3Iso();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE sessions SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ?",
      [startedAt, sessionId],
      function updateErr(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function markSessionCompleted(sessionId) {
  const db = getDb();
  const completedAt = nowGmtPlus3Iso();
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE sessions SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?",
      [completedAt, sessionId],
      function updateErr(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function savePersonaMessage({ participantId, sessionNumber, role, content, sessionPersonaId, conversationId, timestampIso = null }) {
  const db = getDb();
  const createdAt = timestampIso || nowGmtPlus3Iso();
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO messages (participant_id, session_number, role, content, session_persona_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [participantId, sessionNumber, role, content, sessionPersonaId || null, conversationId || null, createdAt],
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
  const createdAt = nowGmtPlus3Iso();
  const normalizedFormKey = String(formKey || "");
  return new Promise((resolve, reject) => {
    // Completion confirmation should be captured exactly once per session.
    // Repeated button presses must not replace the original confirmation timestamp.
    if (normalizedFormKey === "session_completion_confirmed") {
      const selectSql = `SELECT id FROM form_responses WHERE participant_id = ? AND session_number = ? AND form_key = 'session_completion_confirmed' AND IFNULL(session_persona_id, -1) = IFNULL(?, -1) LIMIT 1`;
      db.get(selectSql, [participantId, sessionNumber, sessionPersonaId], (getErr, row) => {
        if (getErr) return reject(getErr);
        if (row && row.id) {
          return resolve(row.id);
        }

        db.run(
          "INSERT INTO form_responses (participant_id, session_number, form_key, responses_json, session_persona_id, created_at) VALUES (?, ?, 'session_completion_confirmed', ?, ?, ?)",
          [participantId, sessionNumber, payload, sessionPersonaId, createdAt],
          function onInsert(err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      });
      return;
    }

    // For the consent form we want to preserve the original completion timestamp.
    // If a consent response already exists for this participant/session (and persona if provided),
    // update the stored responses JSON but keep the original created_at. For other forms,
    // continue to replace prior responses as before.
    if (normalizedFormKey === "consent") {
      const selectSql = `SELECT id FROM form_responses WHERE participant_id = ? AND session_number = ? AND form_key = 'consent' AND IFNULL(session_persona_id, -1) = IFNULL(?, -1) LIMIT 1`;
      db.get(selectSql, [participantId, sessionNumber, sessionPersonaId], (getErr, row) => {
        if (getErr) return reject(getErr);
        if (row && row.id) {
          // Update responses but keep created_at untouched
          db.run(
            "UPDATE form_responses SET responses_json = ? WHERE id = ?",
            [payload, row.id],
            function onUpdate(err) {
              if (err) return reject(err);
              resolve(row.id);
            }
          );
          return;
        }

        // No existing consent row: insert new record
        db.run(
          "INSERT INTO form_responses (participant_id, session_number, form_key, responses_json, session_persona_id, created_at) VALUES (?, ?, 'consent', ?, ?, ?)",
          [participantId, sessionNumber, payload, sessionPersonaId, createdAt],
          function onInsert(err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      });
      return;
    }

    // Default behavior for non-consent forms: replace any existing response for this key
    const deleteSql = `DELETE FROM form_responses WHERE participant_id = ? AND session_number = ? AND form_key = ? AND IFNULL(session_persona_id, -1) = IFNULL(?, -1)`;
    db.serialize(() => {
      db.run(deleteSql, [participantId, sessionNumber, formKey, sessionPersonaId], (delErr) => {
        if (delErr) return reject(delErr);
        db.run(
          "INSERT INTO form_responses (participant_id, session_number, form_key, responses_json, session_persona_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [participantId, sessionNumber, formKey, payload, sessionPersonaId, createdAt],
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
      `INSERT INTO session_personas (session_id, participant_id, session_number, persona_csv_id, persona_order, persona_name, persona_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
        nowGmtPlus3Iso(),
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

export function listParticipantFormResponses(participantId) {
  const db = getDb();
  const query = `
    SELECT fr.id,
           fr.participant_id AS participantId,
           fr.session_number AS sessionNumber,
           fr.form_key AS formKey,
           fr.responses_json AS responsesJson,
           fr.session_persona_id AS sessionPersonaId,
           fr.created_at AS createdAt,
           sp.persona_name AS personaName,
           sp.persona_csv_id AS personaCsvId
    FROM form_responses fr
    LEFT JOIN session_personas sp ON sp.id = fr.session_persona_id
    WHERE fr.participant_id = ?
    ORDER BY fr.session_number ASC, fr.created_at ASC, fr.id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [participantId], (err, rows) => {
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

export function listIncompleteSessionsForAdmin() {
  const db = getDb();
  const query = `
    SELECT p.id AS participantId,
           p.participant_code AS participantCode,
           p.group_assignment AS groupAssignment,
           s.id AS sessionId,
           s.session_number AS sessionNumber,
           s.session_token AS sessionToken,
           s.status AS sessionStatus,
           s.completed_at AS completedAt,
           consent.consent_completed_at AS consentCompletedAt
    FROM sessions s
    JOIN participants p ON p.id = s.participant_id
    JOIN (
      SELECT participant_id, session_number, MAX(created_at) AS consent_completed_at
      FROM form_responses
      WHERE form_key = 'consent'
      GROUP BY participant_id, session_number
    ) consent
      ON consent.participant_id = s.participant_id
      AND consent.session_number = s.session_number
    WHERE s.completed_at IS NULL
      AND s.status != 'completed'
      AND CAST(strftime('%s', consent.consent_completed_at) AS INTEGER) < CAST(strftime('%s', 'now', '-2 hour') AS INTEGER)
    ORDER BY consent.consent_completed_at DESC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function listScheduleLockDisabledSessionsForAdmin() {
  const db = getDb();
  const query = `
    SELECT p.id AS participantId,
           p.participant_code AS participantCode,
           p.group_assignment AS groupAssignment,
           s.id AS sessionId,
           s.session_number AS sessionNumber,
           s.session_token AS sessionToken,
           s.scheduled_for AS scheduledFor,
           s.status AS sessionStatus,
           s.started_at AS startedAt,
           s.completed_at AS completedAt
    FROM sessions s
    JOIN participants p ON p.id = s.participant_id
    WHERE IFNULL(s.schedule_lock_disabled, 0) = 1
    ORDER BY p.created_at DESC, s.session_number ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function listPersonaSessionDistribution({ groupAssignment } = {}) {
  const db = getDb();
  const params = [];
  const where = [];
  if (groupAssignment === "control" || groupAssignment === "experimental") {
    where.push("p.group_assignment = ?");
    params.push(groupAssignment);
  }

  const query = `
    SELECT sp.persona_name AS personaName,
           sp.session_number AS sessionNumber,
        SUM(CASE WHEN s.completed_at IS NOT NULL OR s.status = 'completed' THEN 1 ELSE 0 END) AS completedCount,
        SUM(CASE WHEN s.completed_at IS NULL AND s.status != 'completed' THEN 1 ELSE 0 END) AS openCount,
        COUNT(*) AS appearances
    FROM session_personas sp
      JOIN sessions s ON s.id = sp.session_id
    JOIN participants p ON p.id = sp.participant_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY sp.persona_name, sp.session_number
    ORDER BY sp.persona_name ASC, sp.session_number ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
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

export function saveModuleQuestionResponse({
  participantId,
  sessionId,
  sessionNumber,
  moduleName,
  sectionId,
  sectionNumber,
  questionId,
  questionNumber,
  questionContent,
  answer,
  correctAnswer,
  isCorrect,
  timedate,
  timeSinceStart
}) {
  const db = getDb();
  const normalizedAnswer = answer == null ? "" : String(answer);
  const normalizedCorrect = correctAnswer == null ? null : String(correctAnswer);
  const normalizedCorrectness = isCorrect === null || isCorrect === undefined ? null : (isCorrect ? 1 : 0);

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id
       FROM module_question_responses
       WHERE participant_id = ?
         AND session_number = ?
         AND module_name = ?
         AND section_id = ?
         AND question_id = ?
       LIMIT 1`,
      [participantId, sessionNumber, moduleName, sectionId, questionId],
      (selectErr, row) => {
        if (selectErr) return reject(selectErr);
        if (row?.id) {
          return resolve({ inserted: false, existingId: row.id });
        }

        db.run(
          `INSERT INTO module_question_responses
          (participant_id, session_id, session_number, module_name, section_id, section_number, question_id, question_number, question_content, answer, correct_answer, is_correct, timedate, time_since_start)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            participantId,
            sessionId,
            sessionNumber,
            moduleName,
            sectionId,
            sectionNumber ?? null,
            questionId,
            questionNumber ?? null,
            questionContent || null,
            normalizedAnswer,
            normalizedCorrect,
            normalizedCorrectness,
            timedate || nowGmtPlus3Iso(),
            timeSinceStart == null ? null : Number(timeSinceStart)
          ],
          function onInsert(err) {
            if (err) return reject(err);
            resolve({ inserted: true, id: this.lastID });
          }
        );
      }
    );
  });
}

export function listModuleQuestionResponses({ participantId, sessionNumber, moduleName }) {
  const db = getDb();
  const query = `
    SELECT id,
           participant_id AS participantId,
           session_id AS sessionId,
           session_number AS sessionNumber,
           module_name AS moduleName,
           section_id AS sectionId,
           section_number AS sectionNumber,
           question_id AS questionId,
           question_number AS questionNumber,
           question_content AS questionContent,
           answer,
           correct_answer AS correctAnswer,
           is_correct AS isCorrect,
           timedate,
           time_since_start AS timeSinceStart
    FROM module_question_responses
    WHERE participant_id = ?
      AND session_number = ?
      AND module_name = ?
    ORDER BY section_number ASC, question_number ASC, id ASC
  `;

  return new Promise((resolve, reject) => {
    db.all(query, [participantId, sessionNumber, moduleName], (err, rows) => {
      if (err) return reject(err);
      resolve(
        (rows || []).map((row) => ({
          id: row.id,
          participantId: row.participantId,
          sessionId: row.sessionId,
          sessionNumber: row.sessionNumber,
          moduleName: row.moduleName,
          sectionId: row.sectionId,
          sectionNumber: row.sectionNumber,
          questionId: row.questionId,
          questionNumber: row.questionNumber,
          questionContent: row.questionContent,
          answer: row.answer,
          correctAnswer: row.correctAnswer,
          isCorrect: row.isCorrect,
          timedate: row.timedate,
          timeSinceStart: row.timeSinceStart
        }))
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
          "DELETE FROM module_question_responses WHERE participant_id = ? AND session_number = ?",
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

export function updateSessionScheduleLockByToken(sessionToken, scheduleLockDisabled) {
  const db = getDb();
  const normalized = scheduleLockDisabled ? 1 : 0;

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT s.id AS sessionId,
              s.session_number AS sessionNumber,
              p.participant_code AS participantCode
       FROM sessions s
       JOIN participants p ON p.id = s.participant_id
       WHERE s.session_token = ?
       LIMIT 1`,
      [sessionToken],
      (selectErr, row) => {
        if (selectErr) return reject(selectErr);
        if (!row) return resolve(null);

        db.run(
          "UPDATE sessions SET schedule_lock_disabled = ? WHERE id = ?",
          [normalized, row.sessionId],
          function onUpdate(updateErr) {
            if (updateErr) return reject(updateErr);
            resolve({
              sessionId: row.sessionId,
              sessionNumber: row.sessionNumber,
              participantCode: row.participantCode,
              scheduleLockDisabled: Boolean(normalized)
            });
          }
        );
      }
    );
  });
}

export function deleteParticipantByCode(participantCode) {
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

  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        const participant = await getSql(
          "SELECT id, participant_code AS participantCode FROM participants WHERE participant_code = ? LIMIT 1",
          [participantCode]
        );
        if (!participant) {
          resolve(null);
          return;
        }

        await runSql("BEGIN TRANSACTION");
        await runSql("DELETE FROM messages WHERE participant_id = ?", [participant.id]);
        await runSql("DELETE FROM form_responses WHERE participant_id = ?", [participant.id]);
        await runSql("DELETE FROM module_question_responses WHERE participant_id = ?", [participant.id]);
        await runSql("DELETE FROM session_personas WHERE participant_id = ?", [participant.id]);
        await runSql("DELETE FROM sessions WHERE participant_id = ?", [participant.id]);
        await runSql("DELETE FROM participants WHERE id = ?", [participant.id]);
        await runSql("COMMIT");

        resolve({ id: participant.id, participantCode: participant.participantCode });
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
    db.run("DELETE FROM module_question_responses");
    db.run("DELETE FROM sessions");
    db.run("DELETE FROM participants");
  });
}

// Initialize on import so tables exist before first request.
getDb();
