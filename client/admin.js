const inviteForm = document.getElementById("invite-form");
const inviteResult = document.getElementById("invite-result");
const participantsTable = document.getElementById("participants-table");

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
        <td>${p.participantCode}</td>
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
