const inviteForm = document.getElementById("invite-form");
const inviteResult = document.getElementById("invite-result");
const participantsTable = document.getElementById("participants-table");
const participantsColumnToggles = document.getElementById("participants-column-toggles");
const messagesModal = document.getElementById("messages-modal");
const messagesModalBody = document.getElementById("messages-modal-body");
const messagesModalTitle = document.getElementById("messages-modal-title");
const messagesModalClose = document.getElementById("messages-modal-close");
const messagesModalBackdrop = document.getElementById("messages-modal-backdrop");

const messageColumnDefs = [
  { key: "createdAt", label: "תאריך/שעה", defaultVisible: true },
  { key: "roleLabel", label: "שולח", defaultVisible: true },
  { key: "content", label: "תוכן", defaultVisible: true },
  { key: "sessionNumber", label: "מפגש", defaultVisible: true },
  { key: "conversationId", label: "conversation_id", defaultVisible: false },
  { key: "conversationCreatedAt", label: "תאריך/שעת יצירת השיחה", defaultVisible: false }
];

const participantColumnDefs = [
  { key: "sessionNumber", label: "מפגש", defaultVisible: true },
  { key: "sessionStatus", label: "סטטוס מפגש", defaultVisible: true },
  { key: "sessionStartAt", label: "תחילת מפגש", defaultVisible: true },
  { key: "sessionLink", label: "קישור למפגש", defaultVisible: true },
  { key: "overallStatus", label: "סטטוס כללי", defaultVisible: false }
];

let visibleColumns = new Set(messageColumnDefs.filter((c) => c.defaultVisible).map((c) => c.key));
let visibleParticipantColumns = new Set(
  participantColumnDefs.filter((c) => c.defaultVisible).map((c) => c.key)
);
let currentMessages = [];
let currentParticipantCode = "";

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
            sessionNumber: session.sessionNumber ? `מפגש ${session.sessionNumber}` : "",
            sessionStatus: renderStatusPill(statusObj),
            sessionStartAt: formatDateTime(session.startedAt),
            sessionLink: session.token
              ? `<a href="${origin}/?token=${session.token}" target="_blank" rel="noopener">פתח</a>`
              : ""
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

participantsTable?.addEventListener("click", async (event) => {
  const target = event.target;
  if (target && target.classList.contains("participant-link")) {
    event.preventDefault();
    const code = target.dataset.code;
    messagesModalBody.innerHTML = `<div class="placeholder">טוען הודעות...</div>`;
    messagesModalTitle.textContent = `הודעות עבור ${code}`;
    messagesModal.hidden = false;

    try {
      const resp = await fetch(`/api/admin/participant/${code}/messages`);
      if (!resp.ok) {
        messagesModalBody.innerHTML = `<div class="placeholder">שגיאה בטעינת ההודעות.</div>`;
        return;
      }
      const data = await resp.json();
      renderMessagesModal(code, data.messages || []);
    } catch (err) {
      messagesModalBody.innerHTML = `<div class="placeholder">שגיאה בטעינת ההודעות.</div>`;
    }
  }
});

messagesModalClose?.addEventListener("click", hideMessagesModal);
messagesModalBackdrop?.addEventListener("click", hideMessagesModal);

inviteForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  inviteResult.textContent = "יוצר הזמנה...";

  try {
    const response = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      inviteResult.textContent = "שגיאה ביצירת הזמנה";
      return;
    }

    const data = await response.json();
    const links = (data.sessions || [])
      .map((session) => `<div>מפגש ${session.sessionNumber}: <a href="${session.url}" target="_blank" rel="noopener">${session.url}</a></div>`)
      .join("");
    inviteResult.innerHTML = `<strong>קוד משתתף:</strong> ${data.participantCode}<br />${links}`;
    loadParticipants();
  } catch (error) {
    inviteResult.textContent = "שגיאה ביצירת הזמנה";
  }
});

function initialize() {
  renderParticipantsColumnToggles();
  loadParticipants();
}

initialize();
