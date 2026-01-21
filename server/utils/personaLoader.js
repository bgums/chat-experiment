import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import {
  createSessionPersonas,
  getSessionPersonas
} from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const personasCsvPath = path.join(__dirname, "..", "instructions", "experiment_personas.csv");

// Only keep the columns that are required for prompts or UI (normalized to lower-case)
const PERSONA_ALLOWED_COLUMNS = new Set([
  "patient_id",
  "session",
  "name",
  "age",
  "gender",
  "background",
  "background_ui",
  "style_of_expression",
  "main_markers",
  "emotional_intelligence",
  "resolution_introspection"
]);

const HEADER_ALIAS_MAP = {
  patient_id: "patient_id",
  session: "session",
  name: "name",
  age: "age",
  gender: "gender",
  background: "background",
  background_ui: "background_ui",
  "background ui": "background_ui",
  style_of_expression: "style_of_expression",
  "style of expression": "style_of_expression",
  main_markers: "main_markers",
  "main markers": "main_markers",
  emotional_intelligence: "emotional_intelligence",
  "emotional intelligence": "emotional_intelligence",
  resolution_introspection: "resolution_introspection"
};

let cachedPersonas = null;
let cachedMtime = null;

export function getAllPersonas() {
  return loadPersonasFromCsv();
}

export function getPersonaByPatientId(patientId) {
  const all = loadPersonasFromCsv();
  const needle = String(patientId ?? "").trim();
  if (!needle) return null;
  return (
    all.find((p) => String(p.patient_id ?? "").trim() === needle)
    || null
  );
}

function parseCSV(text) {
  const rows = [];
  let current = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        value += "\"";
        i += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === "\"") {
      inQuotes = true;
    } else if (char === ",") {
      current.push(value);
      value = "";
    } else if (char === "\n") {
      current.push(value);
      rows.push(current);
      current = [];
      value = "";
    } else if (char === "\r") {
      // skip
    } else {
      value += char;
    }
  }
  if (value.length > 0 || current.length > 0) {
    current.push(value);
    rows.push(current);
  }
  return rows;
}

function loadPersonasFromCsv() {
  const stats = fs.statSync(personasCsvPath);
  if (cachedPersonas && cachedMtime && cachedMtime === stats.mtimeMs) {
    return cachedPersonas;
  }

  const raw = fs.readFileSync(personasCsvPath, "utf-8");
  const rows = parseCSV(raw).filter((r) => r.length && r.some((v) => v && v.trim().length));
  if (!rows || !rows.length) {
    cachedPersonas = [];
    cachedMtime = stats.mtimeMs;
    return cachedPersonas;
  }

  const [headerRow, ...dataRows] = rows;
  const headerEntries = headerRow
    .map((h, idx) => {
      const rawKey = String(h || "").trim();
      const normalized = rawKey.toLowerCase();
      const canonical = HEADER_ALIAS_MAP[normalized] || normalized;
      return { key: canonical, idx };
    })
    .filter(({ key }) => key && PERSONA_ALLOWED_COLUMNS.has(key));

  if (!headerEntries.length) {
    cachedPersonas = [];
    cachedMtime = stats.mtimeMs;
    return cachedPersonas;
  }

  function parseValue(key, rawValue) {
    const v = rawValue == null ? "" : String(rawValue).trim();
    // numeric-ish fields convert to numbers when possible
    if (v === "") return "";
    if (/^(patient_id|age|resolution_introspection|emotional_intelligence)$/i.test(key)) {
      const n = Number(v);
      return Number.isNaN(n) ? v : n;
    }
    return v;
  }

  const personas = dataRows.map((row) => {
    const obj = {};
    headerEntries.forEach(({ key, idx }) => {
      obj[key] = parseValue(key, row[idx]);
    });
    return obj;
  });

  cachedPersonas = personas;
  cachedMtime = stats.mtimeMs;
  return personas;
}

function shuffle(array, seed) {
  const result = [...array];
  let currentIndex = result.length;
  let randomSeed = seed;
  while (currentIndex !== 0) {
    randomSeed = crypto.createHash("sha256").update(String(randomSeed)).digest("hex");
    const randomValue = parseInt(randomSeed.slice(0, 8), 16) / 0xffffffff;
    const randomIndex = Math.floor(randomValue * currentIndex);
    currentIndex -= 1;
    const temp = result[currentIndex];
    result[currentIndex] = result[randomIndex];
    result[randomIndex] = temp;
  }
  return result;
}

export function getPersonasForSession(sessionKey) {
  const all = loadPersonasFromCsv();
  const key = String(sessionKey ?? "").trim();
  return all.filter((p) => String(p.session ?? "").trim() === key);
}

// Return a persona object safe for rendering in the UI (hides sensitive/internal fields)
export function maskPersonaForUI(persona) {
  if (!persona) return persona;
  return {
    patient_id: persona.patient_id,
    session: persona.session,
    name: persona.name,
    age: persona.age,
    background_ui: persona.background_ui ?? ""
  };
}

// Convenience getters that return UI-safe persona lists
export function getAllPersonasForUI() {
  return loadPersonasFromCsv().map(maskPersonaForUI);
}

export function getPersonaByPatientIdForUI(patientId) {
  const p = getPersonaByPatientId(patientId);
  return maskPersonaForUI(p);
}

export async function ensureSessionPersonas({ sessionId, participantId, sessionNumber, participantCode }) {
  const existing = await getSessionPersonas(sessionId);
  if (existing && existing.length) return existing;

  const candidates = getPersonasForSession(sessionNumber);
  const fallbackCandidates = candidates.length ? candidates : loadPersonasFromCsv();
  if (!fallbackCandidates.length) {
    throw new Error("No personas found in CSV.");
  }

  const seed = participantCode || `${sessionId}-${sessionNumber}`;
  const randomized = shuffle(fallbackCandidates, seed).slice(0, 2);
  const personas = randomized.map((p, idx) => ({
    personaCsvId: Number(p.patient_id || idx + 1),
    order: idx + 1,
    name: p.name,
    data: p
  }));

  const created = await createSessionPersonas({ sessionId, participantId, sessionNumber, personas });
  return created.map((p) => ({
    ...p,
    personaJson: JSON.stringify(p.data || {})
  }));
}

export function buildPersonaPrompt(personaObj) {
  if (!personaObj) return "";
  const missingValue = "לא צוין";
  const formatLine = (label, value) => {
    const hasValue = value !== undefined && value !== null && String(value).trim() !== "";
    return `${label}: ${hasValue ? value : missingValue}`;
  };

  const fields = [];
  fields.push(formatLine("שם", personaObj.name));
  fields.push(formatLine("מגדר", personaObj.gender));
  fields.push(formatLine("גיל", personaObj.age));
  fields.push(formatLine("מרקרים של קרע", personaObj.main_markers));
  fields.push(formatLine("אינטליגנציה רגשית", personaObj.emotional_intelligence));
  fields.push(formatLine("סגנון הבעה", personaObj.style_of_expression));
  fields.push(formatLine("רקע", personaObj.background));

  return fields.join("\n");
}
