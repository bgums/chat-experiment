// Dedicated practice renderer. Patient dialogue and coaching are separate DOM elements.
export async function renderPractice({ step, container, fetchApi, readOnly, next, isCurrent, parseMarkdown }) {
  const endpoint = `/api/session/${step.token}/persona/${step.sessionPersonaId}/practice`;
  let data;
  let busy = false;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const card = element("section", "", "step-card practice-card");
  card.dir = "rtl";
  const errorBox = element("p", "", "practice-error");
  errorBox.setAttribute("role", "alert");
  container.replaceChildren(card);

  async function request(action, payload = {}) {
    const response = await fetchApi(endpoint + (action ? `/${action}` : ""), action ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    } : {});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "האימון לא נטען. נסו שוב.");
    return result;
  }
  function button(text, action) {
    const node = element("button", text, "ghost-button");
    node.type = "button";
    node.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      node.disabled = true;
      errorBox.textContent = "";
      try { await action(); } catch (error) { errorBox.textContent = error.message; }
      finally { busy = false; node.disabled = false; }
    });
    return node;
  }
  function heading(text) { card.append(element("h3", text)); }
  function formattedMessage(text) {
    const body = element("div", "", "practice-markdown");
    if (!parseMarkdown) { body.textContent = text || ""; return body; }
    const template = document.createElement("template");
    template.innerHTML = parseMarkdown(text || "");
    // Keep text formatting, without executable HTML or model-provided attributes.
    const allowed = new Set(["P", "BR", "STRONG", "B", "EM", "I", "UL", "OL", "LI", "BLOCKQUOTE", "CODE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DEL"]);
    for (const node of [...template.content.querySelectorAll("*")].reverse()) {
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "SVG", "MATH"].includes(node.tagName)) node.remove();
      else if (!allowed.has(node.tagName)) node.replaceWith(...node.childNodes);
      else for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
    }
    body.append(template.content);
    return body;
  }
  function coach(text, attempt = null, title = "טיפ") {
    const note = element("aside", "", "practice-coach");
    if (attempt && data.config.showScoresToParticipant) {
      note.append(element("strong", `ציון: ${attempt.score ?? "טרם הוגדר בפרוטוקול"}`, "practice-score"));
    }
    note.append(element("strong", attempt ? "משוב על הניסיון" : title), formattedMessage(text));
    return note;
  }
  function header() {
    heading("תרגול");
    card.append(element("p", "כעת נבחן חלק מן השיחה עם המטופל, ונתאמן עליו. אנא קראו את קטע השיחה והמשיכו לפידבק ולהוראות התרגול."));
  }
  function loading() {
    if (!isCurrent()) return;
    card.replaceChildren();
    const status = element("p", "טוען את שלב התרגול…", "practice-loading");
    status.setAttribute("role", "status");
    card.append(status);
  }
  async function transition(action) {
    loading();
    try {
      data = await request(action);
      dialogue(data.rounds.at(-1));
    } catch (error) {
      if (!isCurrent()) return;
      errorBox.textContent = error.message;
      card.replaceChildren(errorBox, button("נסה שוב", () => transition(action)));
    }
  }
  function restartButton() {
    return button("התחלה מחדש של האימון", () => transition("restart"));
  }
  function dialogue(round) {
    if (!isCurrent()) return;
    card.replaceChildren();
    header();
    if (!readOnly) card.append(restartButton());
    const chat = element("div", "", "practice-dialogue");
    chat.setAttribute("role", "log");
    chat.setAttribute("aria-label", "שיחת תרגול והכוונה");
    function message(target, role, content) {
      const node = element("article", "", `message message-${role === "user" ? "user" : "assistant"}`);
      node.append(element("strong", role === "user" ? "מטפל/ת" : step.persona?.name || "מטופל/ת"), element("p", content));
      target.append(node);
    }
    const firstExcerptIndex = (data.originalMessages || []).findIndex(message => message.id === round.plan.excerpt[0]?.id);
    const earlierOriginal = firstExcerptIndex > 0 ? data.originalMessages.slice(0, firstExcerptIndex) : [];
    const entries = round.plan.excerpt.map(message => ({ ...message }));
    entries.push({ coaching: round.plan.feedback, title: "פידבק" }, { coaching: round.plan.hint, title: "טיפ" });
    for (const attempt of round.attempts) {
      entries.push({ role: "user", content: attempt.therapist_message }, { role: "assistant", content: attempt.patient_message }, { coaching: attempt.feedback, attempt }, { coaching: attempt.hint || "הפרומפט טרם הוגדר.", title: "טיפ" });
    }
    // Keep exactly the latest three dialogue messages expanded. Coaching is not a message.
    let dialogueCount = 0;
    let visibleFrom = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].role && ++dialogueCount === 3) { visibleFrom = index; break; }
    }
    const hiddenEntries = [...earlierOriginal, ...entries.slice(0, visibleFrom)];
    const history = element("div", "", "practice-history");
    const current = element("div", "", "practice-current");
    function drawEntry(target, entry) {
      if (entry.role) message(target, entry.role, entry.content);
      else target.append(coach(entry.coaching, entry.attempt, entry.title));
    }
    let historyButton;
    if (hiddenEntries.length) {
      historyButton = button("הצג הודעות קודמות", () => {
        history.replaceChildren();
        hiddenEntries.forEach(entry => drawEntry(history, entry));
        chat.scrollTop = 0;
      });
      historyButton.setAttribute("aria-expanded", "false");
      historyButton.classList.add("practice-history-button");
      history.append(historyButton);
      chat.append(history);
    }
    entries.slice(visibleFrom).forEach(entry => drawEntry(current, entry));
    chat.append(current);
    card.append(chat);
    requestAnimationFrame(() => {
      // The disclosure lives above the initial scroll position and is revealed by scrolling up.
      if (historyButton) chat.scrollTop = history.offsetHeight + 16;
      else chat.scrollTop = 0;
    });
    if (round.status !== "active") {
      if (data.rounds.length < data.config.strategiesPerChat && !readOnly) {
        card.append(button("המשך לאסטרטגיה הבאה", () => transition("start")), errorBox);
      } else card.append(button("המשך", next), errorBox);
      return;
    }
    if (readOnly) { card.append(element("p", "מצב צפייה בלבד — התרגול טרם הושלם.")); return; }
    const form = element("form", "", "practice-form");
    const label = element("label", round.attempts.length ? "התגובה שלך למטופל/ת" : "נסחו תגובה חלופית במקום תגובת המטפל/ת המקורית");
    const input = element("textarea");
    input.id = `practice-message-${round.id}`;
    label.htmlFor = input.id;
    input.required = true;
    input.maxLength = round.config.maxMessageLength;
    input.rows = 3;
    const submit = element("button", "שליחה");
    submit.className = "completion-submit-button";
    submit.type = "submit";
    const pending = element("p", "", "muted");
    pending.setAttribute("role", "status");
    form.append(label, input, submit, pending);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy || !input.value.trim()) return;
      busy = true;
      submit.disabled = true;
      input.disabled = true;
      pending.textContent = "המטופל משיב והמשוב בהכנה…";
      errorBox.textContent = "";
      try {
        data = await request("attempt", { roundId: round.id, attemptNumber: round.attempts.length + 1, message: input.value });
        dialogue(data.rounds.at(-1));
      } catch (error) { errorBox.textContent = error.message; }
      finally { busy = false; submit.disabled = false; input.disabled = false; pending.textContent = ""; }
    });
    card.append(form, errorBox);
  }
  async function load() {
    loading();
    data = await request();
    if (!isCurrent()) return;
    if (!data.rounds.length) {
      if (!readOnly) {
        data = await request("start");
        dialogue(data.rounds.at(-1));
      } else {
        card.replaceChildren();
        header();
        card.append(element("p", "אין תרגול שמור לשיחה זו."), button("המשך", next), errorBox);
      }
    } else {
      const round = data.rounds.at(-1);
      dialogue(round);
    }
  }
  loading();
  try { await load(); } catch (error) {
    card.replaceChildren(errorBox, button("נסה שוב", load));
    errorBox.textContent = error.message;
  }
}
