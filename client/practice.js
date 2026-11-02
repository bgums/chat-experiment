// Dedicated practice renderer. Patient dialogue and coaching are separate DOM elements.
export async function renderPractice({ step, container, fetchApi, readOnly, next, isCurrent }) {
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
  function coach(text) {
    const note = element("aside", "", "practice-coach");
    note.append(element("strong", "הכוונה לתרגול"), element("p", text));
    return note;
  }
  function introduction(round) {
    if (!isCurrent()) return;
    card.replaceChildren();
    heading(`כיוון תרגול ${round.round_number}: ${round.plan.title}`);
    if (round.plan.originalStrategyExplanation) card.append(element("p", `בשיחה המקורית: ${round.plan.originalStrategyExplanation}`, "muted"));
    card.append(element("p", round.plan.explanation));
    for (const [label, key] of [["עקרונות", "principles"], ["יישום", "application"]]) {
      card.append(element("h4", label), element("p", round.plan[key]));
    }
    card.append(button("מעבר לתרגול", () => dialogue(round)), errorBox);
  }
  function dialogue(round) {
    if (!isCurrent()) return;
    card.replaceChildren();
    heading(round.plan.title);
    const attemptNumber = round.status === "active" ? round.attempts.length + 1 : round.attempts.length;
    card.append(element("p", `ניסיון ${attemptNumber} מתוך ${round.config.maxAttemptsPerStrategy}`, "muted"));
    const chat = element("div", "", "practice-dialogue");
    chat.setAttribute("role", "log");
    chat.setAttribute("aria-label", "שיחת תרגול והכוונה");
    function message(role, content) {
      const node = element("article", "", `message message-${role === "user" ? "user" : "assistant"}`);
      node.append(element("strong", role === "user" ? "מטפל/ת" : step.persona?.name || "מטופל/ת"), element("p", content));
      chat.append(node);
    }
    round.plan.excerpt.forEach(m => message(m.role, m.content));
    chat.append(coach(round.plan.hint));
    for (const attempt of round.attempts) {
      message("user", attempt.therapist_message);
      message("assistant", attempt.patient_message);
      chat.append(coach(attempt.feedback));
    }
    card.append(chat);
    requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
    if (round.status !== "active") {
      card.append(button("לסיכום התרגול", () => summary(round)), errorBox);
      return;
    }
    if (readOnly) { card.append(element("p", "מצב צפייה בלבד — התרגול טרם הושלם.")); return; }
    const form = element("form", "", "practice-form");
    const label = element("label", "התגובה שלך למטופל/ת");
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
  function summary(round) {
    if (!isCurrent()) return;
    card.replaceChildren();
    heading(`סיכום התרגול: ${round.plan.title}`);
    card.append(element("p", round.attempts.at(-1)?.summary || ""));
    card.append(element("p", round.status === "mastered" ? "האסטרטגיה יושמה במידה המאפשרת להתקדם." : "הגענו למספר הניסיונות שנקבע. אפשר לקחת את הלמידה להמשך התרגול.", "muted"));
    const total = round.config.strategiesPerChat;
    if (data.rounds.length < total && !readOnly) {
      card.append(button("היכרות עם כיוון חדש", async () => { data = await request("start"); introduction(data.rounds.at(-1)); }));
    } else card.append(button("המשך", next));
    card.append(errorBox);
  }
  async function load() {
    data = await request();
    if (!isCurrent()) return;
    if (!data.rounds.length) {
      card.replaceChildren();
      heading("אימון מכוון באיחוי קרעים");
      card.append(element("p", "נחזור לרגע מתוך השיחה ונתרגל דרכי תגובה נוספות."));
      if (!readOnly) card.append(button("בחירת רגע לתרגול", async () => { data = await request("start"); introduction(data.rounds.at(-1)); }));
      else card.append(element("p", "אין תרגול שמור לשיחה זו."), button("המשך", next));
      card.append(errorBox);
    } else {
      const round = data.rounds.at(-1);
      if (round.status !== "active") summary(round);
      else if (round.attempts.length) dialogue(round);
      else introduction(round);
    }
  }
  card.append(element("p", "טוען אימון…"));
  try { await load(); } catch (error) {
    card.replaceChildren(errorBox, button("נסה שוב", load));
    errorBox.textContent = error.message;
  }
}
