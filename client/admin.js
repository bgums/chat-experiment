const inviteForm = document.getElementById("invite-form");
const inviteResult = document.getElementById("invite-result");
const participantsTable = document.getElementById("participants-table");
const messagesModal = document.getElementById("messages-modal");
const messagesModalBody = document.getElementById("messages-modal-body");
const messagesModalTitle = document.getElementById("messages-modal-title");
const messagesModalClose = document.getElementById("messages-modal-close");
const messagesModalBackdrop = document.getElementById("messages-modal-backdrop");

const columnDefs = [
  { key: "createdAt", label: "תאריך/שעה", defaultVisible: true },
  { key: "roleLabel", label: "שולח", defaultVisible: true },
  { key: "content", label: "תוכן", defaultVisible: true },
  { key: "sessionNumber", label: "מפגש", defaultVisible: true },
  { key: "conversationId", label: "conversation_id", defaultVisible: false },
  { key: "conversationCreatedAt", label: "תאריך/שעת יצירת השיחה", defaultVisible: false }
];

let visibleColumns = new Set(columnDefs.filter((c) => c.defaultVisible).map((c) => c.key));
let currentMessages = [];
let currentParticipantCode = "";

function renderParticipantsTable(data) {
  if (!data?.length) {
    participantsTable.innerHTML = "<div class='placeholder'>אין משתתפים עדיין.</div>";
    return;
  }

  const origin = window.location.origin;

  const rows = data
    .map((p) => {
      const links = (p.sessions || [])
        .map((session) => {
          const url = `${origin}/?token=${session.token}`;
          return `<div>מפגש ${session.sessionNumber}: <a href="${url}" target="_blank" rel="noopener">${url}</a></div>`;
        })
        .join("");

      return `<tr>
        <td><a href="#" class="participant-link" data-code="${p.participantCode}">${p.participantCode}</a></td>
        <td>${p.status}</td>
        <td>${p.completedSessions || 0}/${p.totalSessions}</td>
        <td>${links}</td>
        <td>${p.createdAt || ""}</td>
      </tr>`;
    })
    .join("");

  participantsTable.innerHTML = `<table>
    <thead><tr><th>קוד משתתף</th><th>סטטוס</th><th>התקדמות</th><th>קישורים</th><th>נוצר</th></tr></thead>
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

  const toggles = columnDefs
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

  const headers = columnDefs.filter((c) => visibleColumns.has(c.key));
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
  loadParticipants();
}

initialize();
