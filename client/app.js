const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");

const participantPanel = document.getElementById("participant-panel");
const statusText = document.getElementById("status-text");
const sessionLabel = document.getElementById("session-label");
const stepPill = document.getElementById("step-pill");
const stepContainer = document.getElementById("step-container");
const stepBackBtn = document.getElementById("step-back");
const stepForwardBtn = document.getElementById("step-forward");
const chatSection = document.getElementById("chat-section");
let chatWindow = null;
let chatForm = null;
let messageInput = null;
let sendButton = null;
let completeButton = null;

const state = {
  token,
  session: null,
  steps: [],
  currentStepIndex: 0,
  conversationId: null
};

const createMessageElement = (role, markdown) => {
  const wrapper = document.createElement("article");
  wrapper.classList.add("message");
  wrapper.classList.add(role === "user" ? "message-user" : "message-assistant");

  const htmlContent = window.marked.parse(markdown, { mangle: false, headerIds: false });
  wrapper.innerHTML = htmlContent;

  return wrapper;
};

const appendMessage = (role, markdown) => {
  if (!chatWindow) return;
  const messageElement = createMessageElement(role, markdown);
  chatWindow.appendChild(messageElement);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return messageElement;
};

const setLoadingState = (isLoading) => {
  if (sendButton) sendButton.disabled = isLoading;
  if (messageInput) messageInput.disabled = isLoading;
  if (sendButton) sendButton.textContent = isLoading ? "שולח" : "שלח";
};

function setStepIndicator() {
  if (!sessionLabel) return;
  if (!state.steps.length || !state.session) {
    sessionLabel.textContent = "ממתין לקישור";
    return;
  }
  const sessionName = state.session.sessionLabel || `מפגש ${state.session.sessionNumber}`;
  sessionLabel.textContent = `${sessionName} - שלב ${state.currentStepIndex + 1} מתוך ${state.steps.length}`;
}

function renderPlaceholder(text) {
  stepContainer.innerHTML = `<div class="placeholder">${text}</div>`;
}

function renderForm(formDef) {
  const wrapper = document.createElement("div");
  wrapper.classList.add("step-card");

  const title = document.createElement("h3");
  title.textContent = formDef.title || formDef.key;
  wrapper.appendChild(title);

  if (formDef.intro) {
  // Attach event listeners
    const intro = document.createElement("p");
    intro.classList.add("muted");
    intro.textContent = formDef.intro;
    wrapper.appendChild(intro);
  }

  const formEl = document.createElement("form");
  formEl.classList.add("question-list");

  (formDef.statements || []).forEach((statement, index) => {
    const block = document.createElement("div");
    block.classList.add("question");
    const label = document.createElement("label");
    label.textContent = statement;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = `statement_${index}`;
    label.prepend(checkbox);
    block.appendChild(label);
    formEl.appendChild(block);
  });

  (formDef.items || []).forEach((item) => {
    const block = document.createElement("div");
    block.classList.add("question");
    const label = document.createElement("label");
    label.textContent = item.prompt || item.id;
    block.appendChild(label);

    if (item.type === "text") {
      const textarea = document.createElement("textarea");
      textarea.name = item.id;
      textarea.rows = 3;
      textarea.dir = "auto";
      block.appendChild(textarea);
    }

    if (item.type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.name = item.id;
      input.min = item.min ?? 0;
      input.max = item.max ?? 120;
      block.appendChild(input);
    }

    if (item.type === "single") {
      const list = document.createElement("div");
      list.classList.add("option-list");
      (item.options || []).forEach((option) => {
        const optionLabel = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = item.id;
        radio.value = option;
        // Do not set required
        optionLabel.appendChild(radio);
        optionLabel.appendChild(document.createTextNode(option));
        list.appendChild(optionLabel);
      });
      block.appendChild(list);
    }

    if (item.type === "multi") {
      const list = document.createElement("div");
      list.classList.add("option-list");
      (item.options || []).forEach((option) => {
        const optionLabel = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = `${item.id}[]`;
        checkbox.value = option;
        optionLabel.appendChild(checkbox);
        optionLabel.appendChild(document.createTextNode(option));
        list.appendChild(optionLabel);
      });
      block.appendChild(list);
    }

    if (item.type === "likert") {
      const scale = document.createElement("div");
      scale.classList.add("likert-scale");
      const [min, max] = item.scale || [1, 5];
      for (let value = min; value <= max; value += 1) {
        const optionLabel = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = item.id;
        radio.value = value;
        // Do not set required
        optionLabel.appendChild(radio);
        optionLabel.appendChild(document.createTextNode(item.labels?.[value] || String(value)));
        scale.appendChild(optionLabel);
      }
      block.appendChild(scale);
    }

    formEl.appendChild(block);
  });

  if (formDef.requireSignature) {
    const block = document.createElement("div");
    block.classList.add("question");
    const label = document.createElement("label");
    label.textContent = "שם/חתימה";
    const input = document.createElement("input");
    input.name = "signature";
    input.required = true;
    block.appendChild(label);
    block.appendChild(input);
    formEl.appendChild(block);
  }

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "שמור והמשך";
  submit.classList.add("ghost-button");
  formEl.appendChild(submit);

  wrapper.appendChild(formEl);
  stepContainer.innerHTML = "";
  stepContainer.appendChild(wrapper);

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(formEl);
    const responses = {};
    formData.forEach((value, key) => {
      if (key.endsWith("[]")) {
        const cleanKey = key.replace("[]", "");
        responses[cleanKey] = responses[cleanKey] || [];
        responses[cleanKey].push(value);
      } else if (responses[key]) {
        responses[key] = Array.isArray(responses[key]) ? responses[key].concat(value) : [responses[key], value];
      } else {
        responses[key] = value;
      }
    });

    try {
      await fetch(`/api/session/${state.token}/forms/${formDef.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses })
      });
      state.currentStepIndex += 1;
      renderCurrentStep();
    } catch (error) {
      renderPlaceholder("שגיאה בשמירת הטופס, נסו שוב.");
      console.error(error);
    }
  });
}

function renderChat() {
  stepContainer.innerHTML = "";

  const chatSection = document.createElement("section");
  chatSection.className = "chat-section";

  const intro = document.createElement("div");
  intro.classList.add("step-card");
  intro.innerHTML = `<h3>שיחת טיפול</h3><p class="muted">המשיכו את השיחה עם המטופל/ת. תוכלו לחזור לכאן בכל עת דרך אותו קישור.</p>`;
  chatSection.appendChild(intro);

  chatWindow = document.createElement("div");
  chatWindow.className = "chat-window";
  chatWindow.id = "chat-window";
  chatWindow.setAttribute("aria-live", "polite");
  chatSection.appendChild(chatWindow);

  chatForm = document.createElement("form");
  chatForm.className = "input-bar";
  chatForm.style.display = "flex";
  messageInput = document.createElement("textarea");
  messageInput.id = "message-input";
  messageInput.rows = 3;
  messageInput.placeholder = "הקלידו הודעה למטופל...";
  messageInput.dir = "auto";
  messageInput.required = true;
  sendButton = document.createElement("button");
  sendButton.type = "submit";
  sendButton.id = "send-button";
  sendButton.textContent = "שלח";
  chatForm.appendChild(messageInput);
  chatForm.appendChild(sendButton);
  chatSection.appendChild(chatForm);

  completeButton = document.createElement("button");
  completeButton.className = "ghost-button";
  completeButton.id = "complete-session";
  completeButton.textContent = "סיום המפגש";
  completeButton.hidden = false;
  chatSection.appendChild(completeButton);

  stepContainer.appendChild(chatSection);

  // Attach event listeners now that elements exist
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const userMessage = messageInput.value.trim();
    if (!userMessage) return;
    messageInput.value = "";
    await sendChatMessage(userMessage);
  });

  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
    if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = messageInput;
      messageInput.value = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`;
      const caretPosition = selectionStart + 1;
      messageInput.setSelectionRange(caretPosition, caretPosition);
    }
  });

  completeButton.addEventListener("click", async () => {
    completeButton.disabled = true;
    try {
      await fetch(`/api/session/${state.token}/complete`, { method: "POST" });
      if (statusText) statusText.textContent = "המפגש נסגר בהצלחה. ניתן לסגור את העמוד.";
      completeButton.textContent = "הושלם";
    } catch (error) {
      completeButton.disabled = false;
      completeButton.textContent = "סיום המפגש";
    }
  });

  setStepIndicator();
}

async function renderCurrentStep() {
  setStepIndicator();
  // No need to hide chatSection, chatWindow, or chatForm; these are now created dynamically only for the chat step.

  const step = state.steps[state.currentStepIndex];

  if (!step) {
    renderPlaceholder("כל השלבים הושלמו. לחצו על \"סיום המפגש\" כדי לסגור את הסשן.");
    if (completeButton) completeButton.hidden = false;
    return;
  }

  if (completeButton) completeButton.hidden = true;

  // Arrow navigation visibility
  stepBackBtn.style.display = state.currentStepIndex > 0 ? "" : "none";
  stepForwardBtn.style.display = (state.steps && state.currentStepIndex < state.steps.length - 1) ? "" : "none";
  stepBackBtn.disabled = state.currentStepIndex === 0;
  stepForwardBtn.disabled = state.currentStepIndex >= state.steps.length - 1;

  if (step.type === "form") {
    const response = await fetch(`/api/forms/${step.key}`);
    if (!response.ok) {
      renderPlaceholder("לא נמצא טופס עבור שלב זה.");
      return;
    }
    const formDef = await response.json();
    renderForm(formDef);
    return;
  }

  if (step.type === "chat") {
    renderChat();
    if (completeButton) completeButton.hidden = false;
    return;
  }

  renderPlaceholder("סוג שלב לא מוכר בקובץ התצורה.");
}
// Step navigation event listeners
stepBackBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  if (state.currentStepIndex > 0) {
    state.currentStepIndex--;
    renderCurrentStep();
  }
});

stepForwardBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  if (state.steps && state.currentStepIndex < state.steps.length - 1) {
    state.currentStepIndex++;
    renderCurrentStep();
  }
});

async function loadSession() {
  if (!state.token) {
    renderPlaceholder("יש לפתוח את הקישור הייחודי למפגש.");
    return;
  }

  try {
    const response = await fetch(`/api/session/${state.token}`);
    if (!response.ok) {
      renderPlaceholder("לא נמצא מפגש עבור הקישור הזה.");
      statusText.textContent = "קישור לא תקין. פנו לחוקר לקבלת קישור חדש.";
      return;
    }

    const data = await response.json();
    state.session = data;
    state.steps = data.steps || [];
    state.conversationId = data.conversationId || null;
    if (statusText) {
      statusText.textContent = `מפגש ${data.sessionNumber} מתוך ${data.totalSessions || "?"}`;
    }
    if (sessionLabel) {
      sessionLabel.textContent = data.sessionLabel || `Session ${data.sessionNumber}`;
    }
    renderCurrentStep();
  } catch (error) {
    console.error(error);
    renderPlaceholder("שגיאה בטעינת המפגש.");
  }
}

async function sendChatMessage(userMessage) {
  appendMessage("user", userMessage);
  const typingIndicator = appendMessage("assistant", "*המטופל/ת כותב/ת תשובה...*");
  setLoadingState(true);

  try {
    const response = await fetch(`/api/session/${state.token}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: userMessage })
    });

    if (!response.ok) {
      const errorBody = await response.json();
      throw new Error(errorBody?.error || "Request failed");
    }

    const data = await response.json();
    state.conversationId = data.conversationId;

    typingIndicator.remove();
    appendMessage("assistant", data.response || "_No response received._");
  } catch (error) {
    typingIndicator.remove();
    appendMessage("assistant", `**שגיאה בשליחה.**\n\n_${error.message}_`);
  } finally {
    setLoadingState(false);
    messageInput.focus();
  }
}

// Removed top-level event listeners for chatForm, messageInput, and completeButton. Now attached dynamically in renderChat.
 
function initialize() {
  participantPanel.hidden = false;

  if (!state.token) {
    renderPlaceholder("קישור ייחודי נדרש כדי להתחיל.");
    if (sessionLabel) {
      sessionLabel.textContent = "אין קישור";
    }
    return;
  }

  loadSession();
}

initialize();
