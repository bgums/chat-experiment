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
  function coach(text, attempt = null) {
    const note = element("aside", "", "practice-coach");
    if (attempt && data.config.showScoresToParticipant) {
      note.append(element("strong", `ציון: ${attempt.score ?? "טרם הוגדר בפרוטוקול"}`, "practice-score"));
    }
    note.append(element("strong", attempt ? "משוב על הניסיון" : "הכוונה לתרגול"), element("p", text));
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
    function message(target, role, content) {
      const node = element("article", "", `message message-${role === "user" ? "user" : "assistant"}`);
      node.append(element("strong", role === "user" ? "מטפל/ת" : step.persona?.name || "מטופל/ת"), element("p", content));
      target.append(node);
    }
    const firstExcerptIndex = (data.originalMessages || []).findIndex(message => message.id === round.plan.excerpt[0]?.id);
    const earlierOriginal = firstExcerptIndex > 0 ? data.originalMessages.slice(0, firstExcerptIndex) : [];
    const entries = round.plan.excerpt.map(message => ({ ...message }));
    entries.push({ coaching: round.plan.hint });
    for (const attempt of round.attempts) {
      entries.push({ role: "user", content: attempt.therapist_message }, { role: "assistant", content: attempt.patient_message }, { coaching: attempt.feedback, attempt });
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
      else target.append(coach(entry.coaching, entry.attempt));
    }
    let historyButton;
    if (hiddenEntries.length) {
      historyButton = button("הצג הודעות קודמות", () => {
        history.replaceChildren();
        hiddenEntries.forEach(entry => drawEntry(history, entry));
        chat.scrollTop = 0;
      });
      historyButton.setAttribute("aria-expanded", "false");
      history.append(historyButton, element("p", "אנחנו ממליצים להתקדם קדימה בתרגול", "muted"));
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
      card.append(button("לסיכום התרגול", () => summary(round)), errorBox);
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
  function summary(round) {
    if (!isCurrent()) return;
    card.replaceChildren();
    heading(`סיכום התרגול: ${round.plan.title}`);
    card.append(element("p", round.attempts.at(-1)?.summary || ""));
    card.append(element("p", round.status === "early_stopped" ? "התרגול הסתיים. אפשר לקחת את הלמידה להמשך." : "הגענו למספר הניסיונות שנקבע. אפשר לקחת את הלמידה להמשך התרגול.", "muted"));
    const total = data.config.strategiesPerChat;
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
