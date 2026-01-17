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

let cachedPersonas = null;
let cachedMtime = null;

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
  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((h) => h.trim());
  const personas = dataRows.map((row) => {
    const obj = {};
    headers.forEach((key, idx) => {
      obj[key] = row[idx];
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

export function getPersonasForSession(sessionNumber) {
  const all = loadPersonasFromCsv();
  return all
    .map((p) => ({ ...p, session: Number(p.session || 0) }))
    .filter((p) => Number(p.session) === Number(sessionNumber));
}

export async function ensureSessionPersonas({ sessionId, participantId, sessionNumber, participantCode }) {
  const existing = await getSessionPersonas(sessionId);
  if (existing && existing.length) return existing;

  const candidates = getPersonasForSession(sessionNumber);
  if (!candidates.length) {
    throw new Error(`No personas found in CSV for session ${sessionNumber}`);
  }

  const seed = participantCode || `${sessionId}-${sessionNumber}`;
  const randomized = shuffle(candidates, seed).slice(0, 2);
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
  const fields = [];
  fields.push(`שם: ${personaObj.name}`);
  if (personaObj.age) fields.push(`גיל: ${personaObj.age}`);
  if (personaObj.gender) fields.push(`מגדר: ${personaObj.gender}`);
  if (personaObj.diagnosis) fields.push(`אבחנה: ${personaObj.diagnosis}`);
  if (personaObj.background) fields.push(`רקע: ${personaObj.background}`);
  const traits = [
    personaObj.antagonism && `רמת אנטגוניזם: ${personaObj.antagonism}`,
    personaObj.disinhibition && `רמת דיסאינהיביציה: ${personaObj.disinhibition}`,
    personaObj.emotioal_negativity && `רגשות שליליים: ${personaObj.emotioal_negativity}`,
    personaObj.borderline_organization && `ארגון גבולי: ${personaObj.borderline_organization}`,
    personaObj.extraversion_intraversion && `אקסטרוורזיה/אינטרוורזיה: ${personaObj.extraversion_intraversion}`,
    personaObj.introspection && `אינטרוספקציה: ${personaObj.introspection}/10`,
    personaObj.resolution_ease && `קלות איחוי קרעים: ${personaObj.resolution_ease}/10`,
    personaObj.difficulty && `רמת קושי: ${personaObj.difficulty}`
  ].filter(Boolean);
  if (traits.length) {
    fields.push(traits.join("\n"));
  }
  return fields.join("\n");
}
