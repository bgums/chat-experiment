const subjectsPanel = document.getElementById("subjects-panel");
const problemsPanel = document.getElementById("problems-panel");
const groupSelect = document.getElementById("group-select");
const createParticipantForm = document.getElementById("create-participant-form");
const resetSessionForm = document.getElementById("reset-session-form");
const resetSessionTokenInput = document.getElementById("reset-session-token");
const deleteParticipantForm = document.getElementById("delete-participant-form");
const deleteParticipantCodeInput = document.getElementById("delete-participant-code");
const managementResult = document.getElementById("management-result");

const qaGroupFilter = document.getElementById("qa-group-filter");
const qaRefreshBtn = document.getElementById("qa-refresh");
const sessionPerPersonaPanel = document.getElementById("qa-session-per-persona");
const personaPerSessionPanel = document.getElementById("qa-persona-per-session");

const participantModal = document.getElementById("participant-modal");
const participantModalBackdrop = document.getElementById("participant-modal-backdrop");
const participantModalClose = document.getElementById("participant-modal-close");
const participantModalTitle = document.getElementById("participant-modal-title");
const messageSessionFilter = document.getElementById("message-session-filter");
const participantSessionDetails = document.getElementById("participant-session-details");

let participants = [];
let chartInstances = [];
let currentParticipantDetails = null;

function escapeHtml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString("he-IL");
}

function computeStatus(session) {
  const startedAt = session?.consentCompletedAt || null;
  if (!startedAt) return { key: "upcoming", label: "Upcoming" };
  if (session?.completedAt || session?.status === "completed") {
    return { key: "completed", label: "Completed" };
  }
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed < 60 * 60 * 1000) return { key: "in_progress", label: "In Progress" };
  return { key: "incomplete", label: "Incomplete" };
}

function renderStatus(status) {
  if (!status || status.key === "upcoming") {
    return `<span class="status-tag">${escapeHtml(status?.label || "Upcoming")}</span>`;
  }
  return `<span class="status-tag status-${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>`;
}

function normalizePersonaNames(personaNames) {
  if (!personaNames) return "";
  return String(personaNames)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" | ");
}

function roleClass(role) {
  if (role === "user") return "msg-row msg-row-user";
  if (role === "assistant_feedback") return "msg-row msg-row-feedback";
  return "msg-row msg-row-assistant";
}

function roleLabel(role) {
  if (role === "user") return "Participant";
  if (role === "assistant_feedback") return "Feedback";
  return "Persona";
}

function setManagementMessage(text, isError = false, allowHtml = false) {
  if (!managementResult) return;
  managementResult.style.color = isError ? "#8c2020" : "#1b5e34";
  if (allowHtml) {
    managementResult.innerHTML = text;
  } else {
    managementResult.textContent = text;
  }
}

function renderSubjectsPanel() {
  if (!subjectsPanel) return;
  if (!participants.length) {
    subjectsPanel.innerHTML = "<div class='small-muted'>אין משתתפים להצגה.</div>";
    return;
  }

  const rows = [];
  participants.forEach((participant) => {
    const sessions = (participant.sessions || []).slice().sort((a, b) => a.sessionNumber - b.sessionNumber);
    sessions.forEach((session, idx) => {
      const status = computeStatus(session);
      // Determine what to display in the Personas column. If personas exist, show them.
      // For control-group sessions that host the reading modules (sessions 2 and 3),
      // show which half (Withdrawal/Confrontation) that session contains when there
      // are no personas to display.
      let personaDisplay = "-";
      if (session.personaNames) {
        personaDisplay = normalizePersonaNames(session.personaNames);
      } else if (participant.groupAssignment === "control" && (Number(session.sessionNumber) === 2 || Number(session.sessionNumber) === 3)) {
        const reading = participant.readingOrder || "withdrawal_first";
        const firstHalf = reading === "withdrawal_first" ? "withdrawal" : "confrontation";
        const half = Number(session.sessionNumber) === 2 ? firstHalf : (firstHalf === "withdrawal" ? "confrontation" : "withdrawal");
        personaDisplay = `${half.charAt(0).toUpperCase() + half.slice(1)}`;
      }

      rows.push(`
        <tr>
          ${idx === 0 ? `<td rowspan="${sessions.length}"><a href="#" class="id-link participant-link" data-code="${escapeHtml(participant.participantCode)}">${escapeHtml(participant.participantCode)}</a><div class="small-muted">id: ${escapeHtml(participant.id)}</div></td>` : ""}
          ${idx === 0 ? `<td rowspan="${sessions.length}">${escapeHtml(participant.groupAssignment || "")}</td>` : ""}
          <td>${escapeHtml(session.sessionNumber)}</td>
          <td>${escapeHtml(formatDateTime(session.consentCompletedAt))}</td>
          <td>${renderStatus(status)}</td>
          <td>${escapeHtml(personaDisplay || "-")}</td>
          <td>${session.token ? `<a href="/?token=${encodeURIComponent(session.token)}" target="_blank" rel="noopener">פתח</a>` : ""}</td>
        </tr>
      `);
    });
  });

  subjectsPanel.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Participant ID</th>
          <th>Group</th>
          <th>Session</th>
          <th>Session Start Time</th>
          <th>Status</th>
          <th>Personas</th>
          <th>Link</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
}

function renderProblemsPanel(rows) {
  if (!problemsPanel) return;
  if (!rows?.length) {
    problemsPanel.innerHTML = "<div class='small-muted'>אין כרגע מפגשים לא שלמים.</div>";
    return;
  }

  const tableRows = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.participantCode)}</td>
      <td>${escapeHtml(row.participantId)}</td>
      <td>${escapeHtml(row.sessionNumber)}</td>
      <td>${escapeHtml(row.sessionToken)}</td>
      <td>${escapeHtml(formatDateTime(row.consentCompletedAt))}</td>
    </tr>
  `).join("");

  problemsPanel.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>participant_code</th>
          <th>participant_id</th>
          <th>session</th>
          <th>session token</th>
          <th>session start time</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
}

function destroyCharts() {
  chartInstances.forEach((instance) => instance.destroy());
  chartInstances = [];
}

function hexToRgb(hex) {
  const clean = String(hex).replace("#", "");
  const num = Number.parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function tint(hex, ratio) {
  const rgb = hexToRgb(hex);
  return rgbToHex({
    r: rgb.r + (255 - rgb.r) * ratio,
    g: rgb.g + (255 - rgb.g) * ratio,
    b: rgb.b + (255 - rgb.b) * ratio
  });
}

const valueLabelPlugin = {
  id: "valueLabelPlugin",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const dataset = chart.data.datasets[0];
    if (!dataset) return;
    const meta = chart.getDatasetMeta(0);
    ctx.save();
    ctx.font = "700 11px Assistant, Inter, Segoe UI, sans-serif";
    ctx.fillStyle = "#1f2d44";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    meta.data.forEach((arc, index) => {
      const value = Number(dataset.data[index]) || 0;
      if (value <= 0) return;
      const pos = arc.tooltipPosition();
      ctx.fillText(String(value), pos.x, pos.y);
    });

    ctx.restore();
  }
};

function getCategoryPalette(count) {
  const base = ["#1f77b4", "#2ca02c", "#ff7f0e", "#d62728", "#9467bd", "#17becf", "#8c564b", "#bcbd22"];
  const result = [];
  for (let i = 0; i < count; i += 1) result.push(base[i % base.length]);
  return result;
}

function renderSplitPieCharts(container, items, keyLabel, keyValue) {
  if (!container) return;
  if (!items || !Object.keys(items).length) {
    container.innerHTML = "<div class='small-muted'>אין נתונים להצגה.</div>";
    return;
  }

  const entries = Object.entries(items);
  // Build a unified session->color mapping when the values represent sessions.
  let sessionColorMap = null;
  let unifiedLegendHtml = "";
  if (keyValue === "session") {
    const sessionSet = new Set();
    entries.forEach(([, values]) => {
      (values || []).forEach((entry) => {
        if (entry && entry.sessionNumber !== undefined && entry.sessionNumber !== null) {
          sessionSet.add(String(entry.sessionNumber));
        }
      });
    });
    const sessions = Array.from(sessionSet).map((s) => Number(s)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    const sessionPalette = getCategoryPalette(Math.max(1, sessions.length));
    sessionColorMap = {};
    sessions.forEach((s, idx) => {
      sessionColorMap[String(s)] = sessionPalette[idx % sessionPalette.length];
    });
    const legendItems = sessions.map((s) => {
      const color = sessionColorMap[String(s)];
      return `<span class="legend-item" style="margin-right:8px;display:inline-flex;align-items:center;"><span style="width:12px;height:12px;background:${escapeHtml(color)};display:inline-block;margin-right:6px;border-radius:2px;border:1px solid rgba(0,0,0,0.06);"></span>Session ${escapeHtml(String(s))}</span>`;
    }).join("");
    unifiedLegendHtml = `<div class="chart-legend unified-legend" style="margin-bottom:8px">${legendItems}</div>`;
  }

  const blocks = entries.map(([key], idx) => {
    // include the index to avoid collisions when keys contain non-latin characters
    const safe = `chart_${keyLabel}_${idx}_${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    return `
      <div class="chart-card">
        <h4>${escapeHtml(keyLabel === "persona" ? key : `Session ${key}`)}</h4>
        <canvas id="${safe}"></canvas>
      </div>
    `;
  }).join("");

  container.innerHTML = (unifiedLegendHtml || "") + blocks;

  entries.forEach(([key, values], idx) => {
    const safe = `chart_${keyLabel}_${idx}_${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const canvas = document.getElementById(safe);
    if (!canvas || !window.Chart) return;

    const labels = [];
    const data = [];
    const colors = [];

    // For session-per-persona charts (where values are sessions), use the unified session colors
    if (keyValue === "session") {
      values.forEach((entry) => {
        const sessionNum = String(entry.sessionNumber);
        const paletteColor = (sessionColorMap && sessionColorMap[sessionNum]) || getCategoryPalette(values.length)[0];
        const completedCount = Number(entry.completedCount) || 0;
        const openCount = Number(entry.openCount) || 0;

        labels.push(`Session ${entry.sessionNumber} completed`);
        data.push(completedCount);
        colors.push(paletteColor);

        labels.push(`Session ${entry.sessionNumber} open`);
        data.push(openCount);
        colors.push(tint(paletteColor, 0.45));
      });
    } else {
      // For session charts (where values are personas), keep a per-chart palette
      const palette = getCategoryPalette(values.length);
      values.forEach((entry, vidx) => {
        const personaLabel = entry.personaName || `Persona ${vidx + 1}`;
        const totalCount = Number(entry.count) || (Number(entry.completedCount) || 0) + (Number(entry.openCount) || 0);
        labels.push(personaLabel);
        data.push(totalCount);
        colors.push(palette[vidx]);
      });
    }

    const chart = new window.Chart(canvas, {
      type: "pie",
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            display: !(keyValue === "session"),
            position: "bottom",
            labels: { boxWidth: 12 }
          }
        }
      },
      plugins: [valueLabelPlugin]
    });
    chartInstances.push(chart);
  });
}

async function loadParticipants() {
  const response = await fetch("/api/admin/participants");
  if (!response.ok) throw new Error("Failed to load participants");
  const data = await response.json();
  participants = data.participants || [];
  renderSubjectsPanel();
}

async function loadIncompleteSessions() {
  const response = await fetch("/api/admin/problems/incomplete-sessions");
  if (!response.ok) throw new Error("Failed to load problems");
  const data = await response.json();
  renderProblemsPanel(data.sessions || []);
}

async function loadQaDistribution() {
  destroyCharts();
  const group = qaGroupFilter?.value || "all";
  const response = await fetch(`/api/admin/qa/persona-distribution?group=${encodeURIComponent(group)}`);
  if (!response.ok) throw new Error("Failed to load QA data");
  const data = await response.json();
  renderSplitPieCharts(sessionPerPersonaPanel, data.sessionPerPersona || {}, "persona", "session");
  renderSplitPieCharts(personaPerSessionPanel, data.personaPerSession || {}, "session", "persona");
}

function hideParticipantModal() {
  if (participantModal) participantModal.hidden = true;
}

function buildSessionBuckets(details) {
  const sessionMap = new Map();
  (details.sessions || []).forEach((session) => {
    const key = Number(session.sessionNumber);
    if (!sessionMap.has(key)) {
      sessionMap.set(key, {
        sessionNumber: key,
        session,
        forms: [],
        messages: []
      });
    }
  });

  (details.forms || []).forEach((form) => {
    const key = Number(form.sessionNumber) || 0;
    if (!sessionMap.has(key)) {
      sessionMap.set(key, { sessionNumber: key, session: { sessionNumber: key }, forms: [], messages: [] });
    }
    sessionMap.get(key).forms.push(form);
  });

  (details.messages || []).forEach((message) => {
    const key = Number(message.sessionNumber) || 0;
    if (!sessionMap.has(key)) {
      sessionMap.set(key, { sessionNumber: key, session: { sessionNumber: key }, forms: [], messages: [] });
    }
    sessionMap.get(key).messages.push(message);
  });

  return Array.from(sessionMap.values()).sort((a, b) => a.sessionNumber - b.sessionNumber);
}

function renderSessionDetails(details, selectedSession = "all") {
  if (!participantSessionDetails) return;

  const sessions = buildSessionBuckets(details);
  const selectedNum = selectedSession === "all" ? null : Number(selectedSession);
  const filtered = selectedNum == null
    ? sessions
    : sessions.filter((s) => s.sessionNumber === selectedNum);

  if (!filtered.length) {
    participantSessionDetails.innerHTML = "<div class='small-muted'>אין נתונים להצגה למפגש שנבחר.</div>";
    return;
  }

  const content = filtered.map((bucket) => {
    const status = computeStatus(bucket.session || {});

    const formsHtml = bucket.forms.length
      ? bucket.forms.map((form) => {
        const qaRows = (form.qaPairs || []).map((pair) => `
          <div class="qa-item">
            <div><strong>שאלה:</strong> ${escapeHtml(pair.question || pair.key)}</div>
            <div><strong>תשובה:</strong> ${escapeHtml(pair.answer || "")}</div>
          </div>
        `).join("");
        const persona = form.personaName ? ` · ${escapeHtml(form.personaName)}` : "";
        return `
          <div class="qa-item">
            <div><strong>${escapeHtml(form.formKey)}</strong>${persona}</div>
            <div class="small-muted">${escapeHtml(formatDateTime(form.createdAt))}</div>
            ${qaRows || "<div class='small-muted'>ללא תשובות.</div>"}
          </div>
        `;
      }).join("")
      : "<div class='small-muted' style='padding:0 10px 10px;'>אין תשובות טפסים.</div>";

    const chatHtml = bucket.messages.length
      ? `<div class="chat-stream">${bucket.messages.map((message) => `
          <div class="${roleClass(message.role)}">
            <div class="msg-bubble">${escapeHtml(message.content || "")}</div>
            <div class="msg-meta">${escapeHtml(roleLabel(message.role))} · ${escapeHtml(formatDateTime(message.createdAt))}</div>
          </div>
        `).join("")}</div>`
      : "<div class='small-muted' style='padding:0 10px 10px;'>אין הודעות בצ'אט.</div>";

    return `
      <div class="session-block">
        <div class="session-block-header">
          Session ${escapeHtml(bucket.sessionNumber)} · ${renderStatus(status)}
          <span class="small-muted"> · Personas: ${escapeHtml(normalizePersonaNames(bucket.session?.personaNames) || "-")}</span>
        </div>

        <details class="session-collapsible">
          <summary>Form Responses</summary>
          ${formsHtml}
        </details>

        <details class="session-collapsible">
          <summary>Chat</summary>
          ${chatHtml}
        </details>
      </div>
    `;
  }).join("");

  participantSessionDetails.innerHTML = content;
}

function populateMessageSessionFilter(details) {
  if (!messageSessionFilter) return;
  const sessions = (details.sessions || []).slice().sort((a, b) => a.sessionNumber - b.sessionNumber);
  const options = ["<option value='all'>All sessions</option>"];
  sessions.forEach((session) => {
    options.push(`<option value="${escapeHtml(session.sessionNumber)}">Session ${escapeHtml(session.sessionNumber)}</option>`);
  });
  messageSessionFilter.innerHTML = options.join("");
  messageSessionFilter.value = "all";
}

async function openParticipantModal(participantCode) {
  if (!participantCode || !participantModal) return;
  participantModalTitle.textContent = `Participant ${participantCode}`;
  participantSessionDetails.innerHTML = "<div class='small-muted'>טוען נתונים...</div>";
  participantModal.hidden = false;

  try {
    const response = await fetch(`/api/admin/participant/${encodeURIComponent(participantCode)}/details`);
    if (!response.ok) throw new Error("failed to load participant details");
    const data = await response.json();
    currentParticipantDetails = data;
    populateMessageSessionFilter(data);
    renderSessionDetails(data, "all");
  } catch (_error) {
    participantSessionDetails.innerHTML = "<div class='small-muted'>שגיאה בטעינת נתוני מפגש.</div>";
  }
}

async function resetSessionByToken(token) {
  if (!token) return;
  const response = await fetch("/api/admin/session/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "שגיאה באיפוס מפגש.");
  }
  setManagementMessage(`אופס מפגש ${payload.sessionNumber} עבור ${payload.participantCode}`);
}

async function loadSessionOptions() {
  if (!groupSelect) return;
  const response = await fetch("/api/admin/session-options");
  if (!response.ok) return;
  const data = await response.json();
  groupSelect.innerHTML = (data.groups || []).map((group) => `<option value="${group.key}">${group.label}</option>`).join("");
}

async function refreshAllPanels() {
  // Run participants first so persona assignments exist before QA counts.
  await loadParticipants();
  await Promise.all([
    loadIncompleteSessions(),
    loadQaDistribution()
  ]);
}

createParticipantForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setManagementMessage("יוצר משתתף חדש...");
  try {
    const groupAssignment = groupSelect?.value === "control" ? "control" : "experimental";
    const response = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupAssignment })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || "שגיאה ביצירת משתתף.");
    const links = (payload.sessions || [])
      .map((s) => `Session ${escapeHtml(s.sessionNumber)}: <a href="/?token=${encodeURIComponent(s.token)}" target="_blank" rel="noopener">פתח</a>`)
      .join(" · ");
    setManagementMessage(`נוצר: <strong>${escapeHtml(payload.participantCode)}</strong><br>${links}`, false, true);
    await refreshAllPanels();
  } catch (error) {
    setManagementMessage(error.message || "שגיאה ביצירה.", true);
  }
});

resetSessionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = (resetSessionTokenInput?.value || "").trim();
  if (!token) {
    setManagementMessage("יש להזין session token.", true);
    return;
  }

  try {
    await resetSessionByToken(token);
    if (resetSessionTokenInput) resetSessionTokenInput.value = "";
    await refreshAllPanels();
  } catch (error) {
    setManagementMessage(error.message || "שגיאה באיפוס.", true);
  }
});

deleteParticipantForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const participantCode = (deleteParticipantCodeInput?.value || "").trim();
  if (!participantCode) {
    setManagementMessage("יש להזין participant code למחיקה.", true);
    return;
  }
  if (!window.confirm(`למחוק את ${participantCode}?`)) return;

  try {
    const response = await fetch(`/api/admin/participant/${encodeURIComponent(participantCode)}`, {
      method: "DELETE"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || "שגיאה במחיקת משתתף.");
    setManagementMessage(`נמחק בהצלחה: ${payload.participantCode}`);
    if (deleteParticipantCodeInput) deleteParticipantCodeInput.value = "";
    await refreshAllPanels();
  } catch (error) {
    setManagementMessage(error.message || "שגיאה במחיקה.", true);
  }
});

subjectsPanel?.addEventListener("click", async (event) => {
  const target = event.target;
  if (target && target.classList.contains("participant-link")) {
    event.preventDefault();
    await openParticipantModal(target.dataset.code);
  }
});

messageSessionFilter?.addEventListener("change", () => {
  if (!currentParticipantDetails) return;
  renderSessionDetails(currentParticipantDetails, messageSessionFilter.value || "all");
});

qaRefreshBtn?.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    await loadQaDistribution();
  } catch (_error) {
    sessionPerPersonaPanel.innerHTML = "<div class='small-muted'>שגיאה בטעינת QA.</div>";
    personaPerSessionPanel.innerHTML = "<div class='small-muted'>שגיאה בטעינת QA.</div>";
  }
});

qaGroupFilter?.addEventListener("change", () => {
  loadQaDistribution().catch(() => {
    sessionPerPersonaPanel.innerHTML = "<div class='small-muted'>שגיאה בטעינת QA.</div>";
    personaPerSessionPanel.innerHTML = "<div class='small-muted'>שגיאה בטעינת QA.</div>";
  });
});

participantModalClose?.addEventListener("click", hideParticipantModal);
participantModalBackdrop?.addEventListener("click", hideParticipantModal);

async function initialize() {
  try {
    await loadSessionOptions();
    await refreshAllPanels();
  } catch (error) {
    setManagementMessage(error.message || "שגיאה בטעינת הנתונים.", true);
  }
}

initialize();
