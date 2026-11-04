import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import crypto from "node:crypto";
import { participantPracticePayload } from "../server/utils/practicePresentation.js";

// Knowledge is scoped to each role; scoring receives the study rubric, not a PDF search.
const { createPracticeResponse, knowledgeFor, practiceKnowledge } = await import("../server/utils/practiceKnowledge.js");
assert.equal(Object.keys(knowledgeFor("practice_selection").strategies).length, 11);
assert.ok(knowledgeFor("patient").markers);
assert.ok(!knowledgeFor("patient").practiceRubric);
const planForKnowledge = { strategyId: "validate_rupture_experience", originalStrategyId: "acknowledge_contribution" };
const originalKnowledge = knowledgeFor("practice_score", { plan: planForKnowledge, assessmentType: "original" });
assert.deepEqual(Object.keys(originalKnowledge.strategies), ["acknowledge_contribution"]);
assert.deepEqual(Object.keys(knowledgeFor("practice_evaluation", { plan: planForKnowledge }).strategies), ["validate_rupture_experience"]);
assert.equal(originalKnowledge.practiceRubric.version, "dp-quality-v1");
assert.equal(practiceKnowledge.source.sha256.length, 64);
await createPracticeResponse({ instructions: "score", input: JSON.stringify({ plan: planForKnowledge }), text: { format: { name: "practice_score" } } }, async payload => {
  assert.ok(!payload.tools && !payload.tool_choice);
  assert.match(payload.instructions, /dp-quality-v1/);
  return {};
});

const scoredRounds = [{ config: { strategiesPerChat: 2 }, attempts: [{ score: 3, feedback: "משוב" }] }];
assert.equal(participantPracticePayload({ strategiesPerChat: 1, showScoresToParticipant: true }, scoredRounds, []).rounds[0].attempts[0].score, 3);
assert.ok(!("score" in participantPracticePayload({ strategiesPerChat: 1, showScoresToParticipant: false }, scoredRounds, []).rounds[0].attempts[0]));
assert.equal(scoredRounds[0].attempts[0].score, 3); // Redaction never changes research data.

for (const [score, label] of [[1, "טעון שיפור"], [3, "ביצוע טוב, טעון שיפור"], [5, "ביצוע טוב"]]) {
  const visible = participantPracticePayload({ strategiesPerChat: 1, showScoresToParticipant: false }, [{ config: {}, attempts: [{ score }] }], []).rounds[0].attempts[0];
  assert.equal(visible.performanceLabel, label);
  assert.ok(!("score" in visible));
}

const temp = await mkdtemp(path.join(os.tmpdir(), "repair-experiment-"));
const dbPath = path.join(temp, "test.db");
// Start from the previous participant schema to exercise migration as well.
const legacy = new sqlite3.Database(dbPath);
await new Promise((resolve, reject) => legacy.exec(`CREATE TABLE participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, participant_code TEXT UNIQUE NOT NULL,
  group_assignment TEXT DEFAULT 'experimental', reading_order TEXT DEFAULT 'withdrawal_first',
  total_sessions INTEGER DEFAULT 4, created_at TEXT DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'invited'
);
INSERT INTO participants(participant_code, group_assignment) VALUES ('legacy-experiment','experimental'), ('legacy-control','control');
CREATE TABLE practice_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL, therapist_message TEXT NOT NULL,
  patient_message TEXT NOT NULL, feedback TEXT NOT NULL, sufficient INTEGER NOT NULL,
  summary TEXT NOT NULL, evaluation_prompt_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(round_id, attempt_number)
);`, error => error ? reject(error) : resolve()));
await new Promise(resolve => legacy.close(resolve));
const port = 32000 + Math.floor(Math.random() * 10000);
const child = spawn(process.execPath, ["server/index.js"], {
  env: { ...process.env, SQLITE_PATH: dbPath, PORT: String(port), OPENAI_SIMULATE: "1", OPENAI_SIMULATED_RESPONSE_DELAY_MS: "5", OPENAI_VECTOR_STORE_ID: "test", OPENAI_FILE_ID: "test", ADMIN_USER: "test", ADMIN_PASSWORD: "test" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", data => { logs += data; });
child.stderr.on("data", data => { logs += data; });
const base = `http://localhost:${port}`;
const auth = `Basic ${Buffer.from("test:test").toString("base64")}`;
let db;
async function api(url, body, status = 200, extraHeaders = {}) {
  const response = await fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { Authorization: auth, "Content-Type": "application/json", ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
try {
  for (let i = 0; i < 150 && !logs.includes("Server listening"); i++) {
    if (child.exitCode != null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(logs, /Server listening/);
  db = new sqlite3.Database(dbPath);
  const invite = await api("/api/admin/invite", { groupAssignment: "control" });
  assert.equal(invite.groupAssignment, "experiment");
  assert.equal(invite.sessions.length, 4);
  // Compare exact seeded assignments against the experiment arm in main-experiment.
  const oldLoader = execFileSync("git", ["show", "main-experiment:server/utils/personaLoader.js"], { encoding: "utf8" });
  const oldShuffle = oldLoader.slice(oldLoader.indexOf("function shuffle("), oldLoader.indexOf("export function getPersonasForGroup"));
  const oldPlan = oldLoader.slice(oldLoader.indexOf("function buildSessionGroupPlan("), oldLoader.indexOf("export async function ensureSessionPersonas"));
  const legacyPlan = vm.runInNewContext(`${oldShuffle}\n${oldPlan}\nbuildSessionGroupPlan`, { crypto, normalizeGroupKey: value => String(value ?? "").trim() });
  const assigned = await all("SELECT session_number, persona_csv_id, persona_order, persona_json FROM session_personas WHERE participant_id = (SELECT id FROM participants WHERE participant_code = ?) ORDER BY session_number, persona_order", [invite.participantCode]);
  const oldParse = oldLoader.slice(oldLoader.indexOf("function parseCSV("), oldLoader.indexOf("function loadPersonasFromCsv("));
  const parseCSV = vm.runInNewContext(`${oldParse}\nparseCSV`);
  const csvOrder = parseCSV(await readFile("server/instructions/experiment_personas.csv", "utf8")).slice(1).filter(row => row[0]);
  const allPersonas = csvOrder.map(row => JSON.parse(assigned.find(assignedRow => assignedRow.persona_csv_id === Number(row[0])).persona_json));
  const expected = legacyPlan({ allPersonas, participantSeed: invite.participantCode, participantSessions: [1, 2, 3, 4].map(sessionNumber => ({ sessionNumber })), groupAssignment: "experimental" });
  for (const [sessionNumber, personas] of expected) {
    assert.deepEqual(assigned.filter(row => row.session_number === sessionNumber).map(row => row.persona_csv_id), Array.from(personas, persona => Number(persona.patient_id)));
  }
  assert.equal((await all('SELECT "group" FROM participants WHERE participant_code = ?', [invite.participantCode]))[0].group, "experiment");
  assert.equal((await all('SELECT "group" FROM participants WHERE participant_code = ?', ['legacy-experiment']))[0].group, "experiment");
  assert.equal((await all('SELECT "group" FROM participants WHERE participant_code = ?', ['legacy-control']))[0].group, "control");
  assert.ok(!(await all('PRAGMA table_info(participants)')).some(column => ["group_assignment", "reading_order"].includes(column.name)));
  const options = await api("/api/admin/session-options");
  assert.deepEqual(options.groups.map(g => g.key), ["experiment"]);
  const first = await api(`/api/session/${invite.sessions[0].token}`);
  assert.equal(first.steps.filter(s => s.type === "chat").length, 2);
  assert.equal(first.steps.filter(s => s.type === "practice").length, 2);
  assert.ok(!first.steps.some(s => s.type === "feedback" || s.key === "pre_feedback"));
  assert.deepEqual(first.steps.filter(s => s.type === "practice").map(s => s.sessionPersonaId), first.steps.filter(s => s.type === "chat").map(s => s.sessionPersonaId));
  assert.equal(first.steps.filter(s => s.type === "module").length, 1);
  const token = invite.sessions[1].token;
  const session = await api(`/api/session/${token}`);
  assert.equal(session.steps.filter(s => s.type === "practice").length, 2);
  assert.equal(session.steps.some(s => s.type === "module"), false);
  assert.deepEqual(first.steps.filter(s => s.key === "demographics").length, 1);
  assert.ok(!session.steps.some(s => ["consent", "confidentiality_request"].includes(s.key)));
  assert.ok(!first.steps.some(s => ["consent", "confidentiality_request"].includes(s.key)));
  assert.equal(session.steps.some(s => s.key === "demographics"), false);
  for (const meeting of invite.sessions.slice(2)) {
    const overview = await api(`/api/session/${meeting.token}`);
    assert.equal(overview.steps.some(s => s.key === "demographics"), false);
  }
  const personas = session.steps.filter(s => s.type === "chat");
  const [participant] = await all("SELECT id FROM participants WHERE participant_code = ?", [invite.participantCode]);
  const [secondSession] = await all("SELECT id FROM sessions WHERE session_token = ?", [token]);
  const practiceUrl = persona => `/api/session/${token}/persona/${persona.sessionPersonaId}/practice`;
  await api(`/api/session/${token}/complete`, {}, 400);
  await api(practiceUrl(personas[0]) + "/start", {}, 400);
  const firstChat = first.steps.find(s => s.type === "chat");
  await api(`/api/session/${invite.sessions[0].token}/persona/${firstChat.sessionPersonaId}/practice/start`, {}, 400);
  for (const persona of personas) {
    await api(`/api/session/${token}/forms/post_chat`, { sessionPersonaId: persona.sessionPersonaId, responses: {} });
    for (const [role, content] of [["assistant", "שלום"], ["user", "מה קרה בינינו?"], ["assistant", "אני מרגיש שאתה לא מבין אותי"], ["user", persona === personas[0] ? "תגובה מקורית" : "excellent original"]]) {
      await run("INSERT INTO messages(participant_id, session_number, session_persona_id, role, content) VALUES (?, 2, ?, ?, ?)", [participant.id, persona.sessionPersonaId, role, content]);
    }
    const url = practiceUrl(persona);
    let data = await api(url + "/start", {});
    const initial = data.rounds[0];
    assert.deepEqual(initial.plan.excerpt.map(message => message.role), ["user", "assistant", "user"]);
    assert.ok(initial.plan.feedback);
    assert.ok(initial.plan.hint);
    assert.equal(initial.plan.excerpt[1].content, "אני מרגיש שאתה לא מבין אותי");
    assert.equal(initial.plan.excerpt.at(-1).content, persona === personas[0] ? "תגובה מקורית" : "excellent original");
    assert.equal(initial.plan.originalScore, persona === personas[0] ? 3 : 5);
    assert.equal(initial.plan.strategyMode, persona === personas[0] ? "improve_original" : "alternative");
    assert.equal(initial.plan.strategyId === initial.plan.originalStrategyId, persona === personas[0]);
    assert.equal(data.originalMessages[0].content, "שלום");
    assert.equal(data.config.strategiesPerChat, 2);
    assert.equal(initial.config.practiceMode, "continuing");
    assert.equal(data.config.showRestartPractice, false);
    // Read-only requests cannot write or call the model.
    await api(url + "/attempt", {}, 403, { "X-Session-View-Only": "1" });
    await api(url + "/attempt", { roundId: initial.id, attemptNumber: 2, message: "test" }, 409);
    const capped = persona === personas[0];
    for (let n = 1; n <= 3; n++) {
      data = await api(url + "/attempt", { roundId: initial.id, attemptNumber: n, message: capped ? "retry" : "אני מבין את הקושי" });
      assert.equal(data.rounds[0].attempts.length, n);
      assert.equal(Boolean(data.rounds[0].attempts.at(-1).patient_message), initial.config.practiceMode === "continuing");
      assert.equal(data.rounds[0].attempts.at(-1).score, capped ? 1 : 3);
      assert.equal("patient_message" in data.rounds[0].attempts.at(-1), initial.config.practiceMode === "continuing");
      assert.ok(!("sufficient" in data.rounds[0].attempts.at(-1)));
      assert.equal(data.rounds[0].status, n < 3 ? "active" : "attempt_limit");
      if (n < 3) await api(`/api/session/${token}/complete`, {}, 400);
    }
    data = await api(url + "/attempt", { roundId: initial.id, attemptNumber: 3, message: capped ? "retry" : "אני מבין את הקושי" });
    assert.equal(data.rounds[0].attempts.length, 3);
    await api(url + "/attempt", { roundId: initial.id, attemptNumber: 4, message: "retry" }, 409);
    data = await api(url + "/start", {});
    assert.equal(data.rounds.length, 2);
    const second = data.rounds[1];
    assert.equal(second.plan.strategyMode, "alternative");
    assert.notEqual(second.plan.strategyId, initial.plan.strategyId);
    assert.notEqual(second.plan.strategyId, initial.plan.originalStrategyId);
    assert.deepEqual(second.plan.excerpt, initial.plan.excerpt);
    data = await api(url + "/attempt", { roundId: second.id, attemptNumber: 1, message: "excellent response" });
    assert.equal(data.rounds[1].status, "early_stopped");
    assert.equal(data.rounds[1].attempts[0].score, 5);
    assert.ok(data.rounds[1].attempts[0].hint);
    await api(url + "/attempt", { roundId: second.id, attemptNumber: 2, message: "retry" }, 409);
    assert.equal((await api(url + "/start", {})).rounds.length, 2);
  }
  // Original dialogue was never polluted by rehearsal.
  assert.equal((await all("SELECT * FROM messages WHERE participant_id = ? AND session_number = 2", [participant.id])).length, 8);
  const details = await api(`/api/admin/participant/${invite.participantCode}/details`);
  assert.equal(details.practice.length, 4);
  const firstModes = details.practice.filter(round => round.round_number === 1).map(round => round.config.practiceMode);
  assert.deepEqual(firstModes, ["continuing", "continuing"]);
  assert.equal(details.practice[0].group, "experiment");
  const exportedPractice = await api(`/api/admin/participant/${invite.participantCode}/practice/export`);
  assert.equal(exportedPractice.group, "experiment");
  assert.equal(exportedPractice.rounds.length, 4);
  assert.equal(exportedPractice.rounds[0].attempts[0].score, 1);
  assert.ok(exportedPractice.rounds[0].attempts[0].evaluation_prompt_hash);
  assert.ok(!(await all("PRAGMA table_info(practice_attempts)")).some(column => column.name === "sufficient"));
  const outsider = await api("/api/admin/invite", {});
  await api(`/api/session/${outsider.sessions[1].token}/persona/${personas[0].sessionPersonaId}/practice`, undefined, 404);
  const restartUrl = practiceUrl(personas[0]);
  const oldRound = (await api(restartUrl)).rounds[0];
  await api(restartUrl + "/restart", {}, 403, { "X-Session-View-Only": "1" });
  const restarted = (await api(restartUrl + "/restart", {})).rounds[0];
  assert.notEqual(restarted.id, oldRound.id);
  assert.equal(restarted.config.practiceMode, oldRound.config.practiceMode);
  assert.equal(restarted.attempts.length, 0);
  assert.equal(restarted.round_number, 1);
  assert.equal((await all("SELECT * FROM practice_attempts WHERE round_id = ?", [oldRound.id])).length, 0);
  assert.equal((await api(practiceUrl(personas[1]))).rounds[0].attempts.length, 3);
  await api(restartUrl + "/attempt", { roundId: oldRound.id, attemptNumber: 1, message: "stale" }, 409);
  for (let n = 1; n <= 3; n++) await api(restartUrl + "/attempt", { roundId: restarted.id, attemptNumber: n, message: "תגובה חלופית" });
  const restartSecond = (await api(restartUrl + "/start", {})).rounds[1];
  await api(restartUrl + "/attempt", { roundId: restartSecond.id, attemptNumber: 1, message: "excellent response" });
  await api(`/api/session/${token}/complete`, {});
  const csv = await fetch(base + "/api/admin/forms/export", { headers: { Authorization: auth } });
  assert.match(await csv.text(), /"group"/);
  await api("/api/admin/session/reset", { token });
  assert.equal((await all("SELECT * FROM practice_rounds WHERE session_id = ?", [secondSession.id])).length, 0);
  assert.equal((await all("SELECT * FROM practice_attempts")).length, 0);
  const batch = await api("/api/admin/invite-balanced-batch", {});
  assert.ok(batch.participants.every(p => p.groupAssignment === "experiment"));
  for (const p of batch.participants) assert.equal(new Set(Object.values(p.sessionGroupMap)).size, 4);
  assert.doesNotMatch(logs, /SQLITE_ERROR|Failed to add|Could not remove/);
  console.log("PASS: flow, experiment group, practice selection, two strategies, original score routing, score-5 stopping, three-attempt cap, restart, legacy flag removal, persistence, ownership, read-only, completion, export, reset, balanced allocation");
} finally {
  if (db) await new Promise(resolve => db.close(resolve));
  child.kill();
  await new Promise(resolve => child.exitCode != null ? resolve() : child.once("exit", resolve));
  await rm(temp, { recursive: true, force: true });
}
