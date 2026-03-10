const inviteForm = document.getElementById("invite-form");
const inviteResult = document.getElementById("invite-result");
const groupSelect = document.getElementById("group-select");
const readingOrderSelect = document.getElementById("reading-order-select");
const participantsTable = document.getElementById("participants-table");
const participantsColumnToggles = document.getElementById("participants-column-toggles");
const messagesModal = document.getElementById("messages-modal");
const messagesModalBody = document.getElementById("messages-modal-body");
const messagesModalTitle = document.getElementById("messages-modal-title");
const messagesModalClose = document.getElementById("messages-modal-close");
const messagesModalBackdrop = document.getElementById("messages-modal-backdrop");
const formsTable = document.getElementById("forms-table");
const formFilterSelect = document.getElementById("form-filter");
const refreshFormsBtn = document.getElementById("refresh-forms");
const downloadAllFormsBtn = document.getElementById("download-all-forms");
const downloadFilteredFormsBtn = document.getElementById("download-filtered-forms");
const formsSummary = document.getElementById("forms-summary");
const resetSessionForm = document.getElementById("reset-session-form");
const resetSessionTokenInput = document.getElementById("reset-session-token");
const resetSessionResult = document.getElementById("reset-session-result");

const messageColumnDefs = [
  { key: "createdAt", label: "תאריך/שעה", defaultVisible: true },
  { key: "roleLabel", label: "שולח", defaultVisible: true },
  { key: "content", label: "תוכן", defaultVisible: true },
  { key: "sessionNumber", label: "מפגש", defaultVisible: true },
  { key: "conversationId", label: "conversation_id", defaultVisible: false },
  { key: "conversationCreatedAt", label: "תאריך/שעת יצירת השיחה", defaultVisible: false }
];

const participantColumnDefs = [
  { key: "groupAssignment", label: "קבוצה", defaultVisible: true },
  { key: "readingOrder", label: "סדר קריאה", defaultVisible: true },
  { key: "sessionNumber", label: "מפגש", defaultVisible: true },
  { key: "sessionStatus", label: "סטטוס מפגש", defaultVisible: true },
  { key: "sessionStartAt", label: "תחילת מפגש", defaultVisible: true },
  { key: "sessionLink", label: "קישור למפגש", defaultVisible: true },
  { key: "sessionPath", label: "סיומת קישור", defaultVisible: true },
  { key: "sessionToken", label: "token מלא", defaultVisible: false },
  { key: "overallStatus", label: "סטטוס כללי", defaultVisible: false }
];

function escapeHtml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let visibleColumns = new Set(messageColumnDefs.filter((c) => c.defaultVisible).map((c) => c.key));
let visibleParticipantColumns = new Set(
  participantColumnDefs.filter((c) => c.defaultVisible).map((c) => c.key)
);
let currentMessages = [];
let currentParticipantCode = "";
let formResponses = [];
let currentFormKey = "all";

function formatDateTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("he-IL");
}

function computeSessionStatus(session) {
  if (!session?.startedAt) {
    return { label: "Upcoming", className: "status-upcoming" };
  }
  if (session?.completedAt || session?.status === "completed") {
    return { label: "Completed", className: "status-completed" };
  }
  const elapsedMs = Date.now() - new Date(session.startedAt).getTime();
  if (elapsedMs < 60 * 60 * 1000) {
    return { label: "In Progress", className: "status-in-progress" };
  }
  return { label: "Incomplete", className: "status-incomplete" };
}

function computeOverallStatus(participant) {
  const sessions = participant.sessions || [];
  const startedCount = sessions.filter((s) => s.startedAt).length;
  const completedCount = sessions.filter((s) => s.completedAt || s.status === "completed").length;
  if (startedCount === 0) {
    return { label: "Upcoming", className: "status-upcoming" };
  }
  if (participant.totalSessions && completedCount >= participant.totalSessions) {
    return { label: "Completed", className: "status-completed" };
  }
  return { label: "In Progress", className: "status-in-progress" };
}

function renderStatusPill(statusObj) {
  const safeLabel = statusObj?.label || "";
  const safeClass = statusObj?.className || "status-upcoming";
  return `<span class="status-pill ${safeClass}">${safeLabel}</span>`;
}

function renderParticipantsColumnToggles() {
  if (!participantsColumnToggles) return;
  const toggles = participantColumnDefs
    .map((c) => {
      const checked = visibleParticipantColumns.has(c.key) ? "checked" : "";
      return `<label class="column-toggle"><input type="checkbox" data-col="${c.key}" ${checked}> ${c.label}</label>`;
    })
    .join("");
  participantsColumnToggles.innerHTML = toggles;
  participantsColumnToggles.addEventListener("change", (event) => {
    const col = event.target?.dataset?.col;
    if (!col) return;
    if (event.target.checked) {
      visibleParticipantColumns.add(col);
    } else {
      visibleParticipantColumns.delete(col);
    }
    renderParticipantsTable(currentParticipants || []);
  });
}

let currentParticipants = [];

function renderParticipantsTable(data) {
  currentParticipants = data || [];
  if (!data?.length) {
    participantsTable.innerHTML = "<div class='placeholder'>אין משתתפים עדיין.</div>";
    return;
  }

  const origin = window.location.origin;
  const visibleSessionColumns = participantColumnDefs.filter(
    (c) => c.key !== "overallStatus" && visibleParticipantColumns.has(c.key)
  );
  const showOverallStatus = visibleParticipantColumns.has("overallStatus");

  const headerCells = [
    ...visibleSessionColumns.map((c) => `<th>${c.label}</th>`),
    ...(showOverallStatus ? ["<th>סטטוס כללי</th>"] : []),
    "<th>קוד משתתף</th>"
  ];

  const rows = data
    .map((p) => {
      const sessions = (p.sessions || []).slice().sort((a, b) => a.sessionNumber - b.sessionNumber);
      const rowSpan = sessions.length || 1;
      const overallStatus = computeOverallStatus(p);

      if (!sessions.length) {
        const sessionCells = visibleSessionColumns
          .map(() => "<td></td>")
          .join("");
        const overallCell = showOverallStatus
          ? `<td rowspan="${rowSpan}">${renderStatusPill(overallStatus)}</td>`
          : "";
        const participantCell = `<td rowspan="${rowSpan}"><a href="#" class="participant-link" data-code="${p.participantCode}">${p.participantCode}</a></td>`;
        return `<tr>${sessionCells}${overallCell}${participantCell}</tr>`;
      }

      return sessions
        .map((session, idx) => {
          const statusObj = computeSessionStatus(session);
          const sessionValues = {
            groupAssignment: p.groupAssignment === "control" ? "Control" : "Experimental",
            readingOrder: p.readingOrder === "confrontation_first"
              ? "Confrontation → Withdrawal"
              : "Withdrawal → Confrontation",
            sessionNumber: session.sessionNumber ? `מפגש ${session.sessionNumber}` : "",
            sessionStatus: renderStatusPill(statusObj),
            sessionStartAt: formatDateTime(session.startedAt),
            sessionLink: session.token
              ? `<a href="${origin}/?token=${session.token}" target="_blank" rel="noopener">פתח</a>`
              : "",
            sessionPath: session.token ? `/?token=${session.token}` : "",
            sessionToken: session.token || ""
          };

          const cells = visibleSessionColumns
            .map((col) => `<td>${sessionValues[col.key] ?? ""}</td>`)
            .join("");

          const overallCell = showOverallStatus && idx === 0
            ? `<td rowspan="${rowSpan}">${renderStatusPill(overallStatus)}</td>`
            : "";
          const participantCell = idx === 0
            ? `<td rowspan="${rowSpan}"><a href="#" class="participant-link" data-code="${p.participantCode}">${p.participantCode}</a></td>`
            : "";

          return `<tr>${cells}${overallCell}${participantCell}</tr>`;
        })
        .join("");
    })
    .join("");

  participantsTable.innerHTML = `<table>
    <thead><tr>${headerCells.join("")}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function loadParticipants() {
  const response = await fetch("/api/admin/participants");
  if (!response.ok) return;
  const data = await response.json();
  renderParticipantsTable(data.participants || []);
}

function renderFormFilterOptions(formKeys) {
  if (!formFilterSelect) return;
  const uniqueKeys = Array.from(new Set(formKeys || [])).filter(Boolean).sort();
  const previous = formFilterSelect.value || "all";
  const options = ["<option value='all'>כל הטפסים</option>", ...uniqueKeys.map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(key)}</option>`)];
  formFilterSelect.innerHTML = options.join("");
  if (uniqueKeys.includes(previous)) {
    formFilterSelect.value = previous;
  }
}

function formatResponseValue(value) {
  if (Array.isArray(value)) return value.join(" | ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value ?? "";
}

function renderResponseBadges(responses) {
  const entries = Object.entries(responses || {});
  if (!entries.length) return "<span class='muted'>ללא תשובות</span>";
  return `<div class="response-chips">${entries
    .map(([key, value]) => {
      const formatted = escapeHtml(formatResponseValue(value));
      return `<span class="response-chip"><strong>${escapeHtml(key)}:</strong> ${formatted}</span>`;
    })
    .join("")}</div>`;
}

function renderFormsTable(data) {
  if (!formsTable) return;
  if (!data?.length) {
    formsTable.innerHTML = "<div class='placeholder'>אין תשובות לשמירה עדיין.</div>";
    return;
  }

  const headerRow = ["טופס", "משתתף", "מפגש", "מטופל/ת", "נוצר ב", "תשובות"]
    .map((h) => `<th>${h}</th>`)
    .join("");

  const rows = data
    .map((row) => {
      const personaLabel = row.sessionPersonaId
        ? `${escapeHtml(row.personaName || "מטופל")}${row.personaCsvId ? ` (#${row.personaCsvId})` : ""}`
        : "—";
      const participantLink = row.participantCode
        ? `<a href="#" class="participant-link" data-code="${escapeHtml(row.participantCode)}">${escapeHtml(row.participantCode)}</a>`
        : "";
      return `<tr>
        <td>${escapeHtml(row.formKey)}</td>
        <td>${participantLink}</td>
        <td>${escapeHtml(row.sessionNumber)}</td>
        <td>${personaLabel}</td>
        <td>${escapeHtml(formatDateTime(row.createdAt))}</td>
        <td>${renderResponseBadges(row.responses)}</td>
      </tr>`;
    })
    .join("");

  formsTable.innerHTML = `<div class="messages-table"><table><thead><tr>${headerRow}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function loadFormResponses() {
  if (!formsTable) return;
  const formKey = formFilterSelect?.value && formFilterSelect.value !== "all" ? formFilterSelect.value : null;
  const qs = formKey ? `?formKey=${encodeURIComponent(formKey)}` : "";
  formsTable.innerHTML = "<div class='placeholder'>טוען תשובות...</div>";
  try {
    const resp = await fetch(`/api/admin/forms/responses${qs}`);
    if (!resp.ok) throw new Error("request failed");
    const data = await resp.json();
    renderFormFilterOptions(data.formKeys || []);
    formResponses = data.responses || [];
    currentFormKey = formKey || "all";
    renderFormsTable(formResponses);
    if (formsSummary) {
      const label = formKey ? `טופס ${formKey}` : "כל הטפסים";
      formsSummary.textContent = `${label}: ${formResponses.length} רשומות`;
    }
  } catch (error) {
    formsTable.innerHTML = "<div class='placeholder'>שגיאה בטעינת תשובות הטפסים.</div>";
  }
}

function downloadForms(formKey) {
  const qs = formKey ? `?formKey=${encodeURIComponent(formKey)}` : "";
  window.location.href = `/api/admin/forms/export${qs}`;
}

function hideMessagesModal() {
  if (messagesModal) messagesModal.hidden = true;
}

function renderMessagesModal(participantCode, messages) {
  currentParticipantCode = participantCode;
  currentMessages = messages || [];
  messagesModalTitle.textContent = `הודעות עבור ${participantCode}`;

  const toggles = messageColumnDefs
    .map((c) => {
      const checked = visibleColumns.has(c.key) ? "checked" : "";
      return `<label class="column-toggle"><input type="checkbox" data-col="${c.key}" ${checked}> ${c.label}</label>`;
    })
    .join("");

  messagesModalBody.innerHTML = `
    <div class="column-toggles">${toggles}</div>
    <div id="messages-table-container"></div>
  `;

  const togglesContainer = messagesModalBody.querySelector(".column-toggles");
  togglesContainer.addEventListener("change", (event) => {
    const col = event.target?.dataset?.col;
    if (!col) return;
    if (event.target.checked) {
      visibleColumns.add(col);
    } else {
      visibleColumns.delete(col);
    }
    renderMessagesTable();
  });

  renderMessagesTable();
  messagesModal.hidden = false;
}

function renderMessagesTable() {
  const container = document.getElementById("messages-table-container");
  if (!container) return;

  if (!currentMessages.length) {
    container.innerHTML = `<div class="placeholder">אין הודעות זמינות למשתתף זה.</div>`;
    return;
  }

  const headers = messageColumnDefs.filter((c) => visibleColumns.has(c.key));
  const headerRow = headers.map((h) => `<th>${h.label}</th>`).join("");

  const rows = currentMessages
    .map((m) => {
      const roleLabel = m.role === "assistant" ? "מטפל" : "משתתף";
      const values = {
        createdAt: m.createdAt || "",
        roleLabel,
        content: m.content || "",
        sessionNumber: m.sessionNumber || "",
        conversationId: m.conversationId || "",
        conversationCreatedAt: m.conversationCreatedAt || ""
      };
      const cells = headers.map((h) => `<td>${values[h.key] ?? ""}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  container.innerHTML = `
    <div class="messages-table">
      <table>
        <thead><tr>${headerRow}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function openMessagesModalForParticipant(code) {
  if (!code) return;
  messagesModalBody.innerHTML = `<div class="placeholder">טוען הודעות...</div>`;
  messagesModalTitle.textContent = `הודעות עבור ${code}`;
  messagesModal.hidden = false;

  try {
    const resp = await fetch(`/api/admin/participant/${code}/messages`);
    if (!resp.ok) throw new Error("load failed");
    const data = await resp.json();
    renderMessagesModal(code, data.messages || []);
  } catch (err) {
    messagesModalBody.innerHTML = `<div class="placeholder">שגיאה בטעינת ההודעות.</div>`;
  }
}

participantsTable?.addEventListener("click", async (event) => {
  const target = event.target;
  if (target && target.classList.contains("participant-link")) {
    event.preventDefault();
    await openMessagesModalForParticipant(target.dataset.code);
  }
});

formsTable?.addEventListener("click", async (event) => {
  const target = event.target;
  if (target && target.classList.contains("participant-link")) {
    event.preventDefault();
    await openMessagesModalForParticipant(target.dataset.code);
  }
});

messagesModalClose?.addEventListener("click", hideMessagesModal);
messagesModalBackdrop?.addEventListener("click", hideMessagesModal);

formFilterSelect?.addEventListener("change", () => {
  loadFormResponses();
});

refreshFormsBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  loadFormResponses();
});

downloadAllFormsBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  downloadForms(null);
});

downloadFilteredFormsBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  const selectedKey = formFilterSelect?.value && formFilterSelect.value !== "all" ? formFilterSelect.value : null;
  downloadForms(selectedKey);
});

inviteForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  inviteResult.textContent = "יוצר הזמנה...";

  try {
    const groupAssignment = groupSelect?.value === "control" ? "control" : "experimental";
    const readingOrder = readingOrderSelect?.value === "confrontation_first"
      ? "confrontation_first"
      : "withdrawal_first";
    const response = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupAssignment, readingOrder })
    });

    if (!response.ok) {
      inviteResult.textContent = "שגיאה ביצירת הזמנה";
      return;
    }

    const data = await response.json();
    const links = (data.sessions || [])
      .map((session) => (
        `<div>מפגש ${session.sessionNumber}: <a href="${session.url}" target="_blank" rel="noopener">${session.url}</a>` +
        ` <div class="muted">סיומת קישור לשיתוף: ${session.path}</div></div>`
      ))
      .join("");
    const groupLabel = data.groupAssignment === "control" ? "Control" : "Experimental";
    const orderLabel = data.readingOrder === "confrontation_first"
      ? "Confrontation → Withdrawal"
      : "Withdrawal → Confrontation";
    inviteResult.innerHTML = `<strong>קוד משתתף:</strong> ${data.participantCode}<br />` +
      `<div><strong>קבוצה:</strong> ${groupLabel}</div>` +
      `<div><strong>סדר קריאה:</strong> ${orderLabel}</div>` +
      `${links}`;
    loadParticipants();
  } catch (error) {
    inviteResult.textContent = "שגיאה ביצירת הזמנה";
  }
});

resetSessionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = (resetSessionTokenInput?.value || "").trim();
  if (!token) {
    if (resetSessionResult) {
      resetSessionResult.textContent = "יש להזין token לפני האיפוס.";
    }
    return;
  }

  if (resetSessionResult) {
    resetSessionResult.textContent = "מאפס מפגש...";
  }

  try {
    const response = await fetch("/api/admin/session/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || "שגיאה באיפוס המפגש.");
    }

    if (resetSessionResult) {
      resetSessionResult.innerHTML = `המפגש אופס בהצלחה: משתתף ${escapeHtml(payload.participantCode || "")} · מפגש ${escapeHtml(payload.sessionNumber || "")}`;
    }
    if (resetSessionTokenInput) {
      resetSessionTokenInput.value = "";
    }
    loadParticipants();
  } catch (error) {
    if (resetSessionResult) {
      resetSessionResult.textContent = error?.message || "שגיאה באיפוס המפגש.";
    }
  }
});

async function loadSessionOptions() {
  if (!groupSelect || !readingOrderSelect) return;
  try {
    const response = await fetch("/api/admin/session-options");
    if (!response.ok) return;
    const data = await response.json();
    const groupOptions = (data.groups || []).map((group) =>
      `<option value="${group.key}">${group.label}</option>`
    );
    const readingOrderOptions = (data.readingOrders || []).map((order) =>
      `<option value="${order.key}">${order.label}</option>`
    );
    groupSelect.innerHTML = groupOptions.join("");
    readingOrderSelect.innerHTML = readingOrderOptions.join("");
    toggleReadingOrderVisibility();
  } catch (error) {
    console.warn("Failed to load session options", error);
  }
}

function toggleReadingOrderVisibility() {
  if (!groupSelect || !readingOrderSelect) return;
  const isControl = groupSelect.value === "control";
  readingOrderSelect.disabled = !isControl;
}

groupSelect?.addEventListener("change", toggleReadingOrderVisibility);

function initialize() {
  renderParticipantsColumnToggles();
  loadSessionOptions();
  loadParticipants();
  loadFormResponses();
}

initialize();
