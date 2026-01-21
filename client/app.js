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
let timerBadge = null;
let personaHeader = null;
let chatTimerInterval = null;
let currentChatStep = null;
let chatLocked = false;
let midPrimeTimeout = null;
let activeFormController = null;

let moduleState = null;
// Persist nextBtnRef across renders to avoid ReferenceError
let nextBtnRef = null;

const state = {
  token,
  session: null,
  steps: [],
  currentStepIndex: 0,
  conversationId: null,
  personas: {}
};

const CHAT_DURATION_MINUTES = 2.5;
const CHAT_DURATION_MS = CHAT_DURATION_MINUTES * 60 * 1000;
const MID_PROMPT_MINUTES = 7;
const MID_PROMPT_MS = MID_PROMPT_MINUTES * 60 * 1000;

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

const formatDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

async function fetchSavedFormResponses(formKey, step = {}) {
  if (!state.token) return { responses: {} };
  const params = new URLSearchParams();
  if (step.sessionPersonaId) {
    params.set("sessionPersonaId", step.sessionPersonaId);
  }
  const query = params.toString();
  const url = query
    ? `/api/session/${state.token}/forms/${formKey}?${query}`
    : `/api/session/${state.token}/forms/${formKey}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return { responses: {} };
    }
    return await resp.json();
  } catch (error) {
    console.error("fetchSavedFormResponses failed", error);
    return { responses: {} };
  }
}

const stopChatTimer = () => {
  if (chatTimerInterval) {
    clearInterval(chatTimerInterval);
    chatTimerInterval = null;
  }
};

const setChatLockState = (locked, reasonText = "") => {
  chatLocked = locked;
  if (messageInput) messageInput.disabled = locked;
  if (sendButton) {
    sendButton.disabled = locked;
    sendButton.textContent = locked ? "הזמן נגמר" : "שלח";
  }
  if (timerBadge) {
    timerBadge.classList.toggle("timer-expired", locked);
    timerBadge.title = locked && reasonText ? reasonText : "";
  }
  if (locked) {
    updateStepNavigationVisibility(currentChatStep);
  }
};

const isChatFinished = (step) => {
  if (!step?.firstMessageAt) return false;
  const elapsed = Date.now() - new Date(step.firstMessageAt).getTime();
  return elapsed >= CHAT_DURATION_MS;
};

const updateStepNavigationVisibility = (step) => {
  if (!stepBackBtn || !stepForwardBtn) return;
  const isChatStep = step?.type === "chat";
  const shouldHideForChat = isChatStep && !isChatFinished(step);
  if (shouldHideForChat) {
    stepBackBtn.style.display = "none";
    stepForwardBtn.style.display = "none";
    return;
  }
  stepBackBtn.style.display = state.currentStepIndex > 0 ? "" : "none";
  // Always keep the forward button visible so the last step can move to the finished screen.
  stepForwardBtn.style.display = state.steps && state.steps.length ? "" : "none";
  stepBackBtn.disabled = state.currentStepIndex === 0;
  stepForwardBtn.disabled = false;
};

const startChatTimer = (startIso) => {
  stopChatTimer();
  if (midPrimeTimeout) {
    clearTimeout(midPrimeTimeout);
    midPrimeTimeout = null;
  }
  if (!startIso) return;
  const startMs = new Date(startIso).getTime();
  const limitMs = CHAT_DURATION_MS;
  const midMs = MID_PROMPT_MS;
  chatTimerInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - startMs;
    if (timerBadge) {
      timerBadge.textContent = `זמן שיחה: ${formatDuration(elapsed)}`;
    }
    if (elapsed >= limitMs) {
      setChatLockState(true, `חלפו ${CHAT_DURATION_MINUTES} דקות`);
      stopChatTimer();
    }
    // mid-chat timer hint (client only, server enforces and logs)
    if (elapsed >= midMs && timerBadge) {
      timerBadge.classList.add("timer-mid");
    }
  }, 1000);
};

const scheduleMidPrime = (startIso, sessionPersonaId) => {
  if (midPrimeTimeout) {
    clearTimeout(midPrimeTimeout);
    midPrimeTimeout = null;
  }
  if (!startIso || !sessionPersonaId) return;
  const startMs = new Date(startIso).getTime();
  const midMs = MID_PROMPT_MS;
  const now = Date.now();
  const delay = Math.max(0, midMs - (now - startMs));
  midPrimeTimeout = setTimeout(async () => {
    try {
      await fetch(`/api/session/${state.token}/persona/${sessionPersonaId}/mid-prime`, { method: "POST" });
    } catch (error) {
      console.warn("mid-prime failed", error);
    }
  }, delay);
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

function renderForm(formDef, step = {}, savedResponses = {}) {
  activeFormController = null;
  const wrapper = document.createElement("div");
  wrapper.classList.add("step-card");

  const title = document.createElement("h3");
  title.textContent = formDef.title || formDef.key;
  wrapper.appendChild(title);

  if (step?.persona?.name) {
    const personaLine = document.createElement("p");
    personaLine.classList.add("muted");
    personaLine.textContent = `עבור המטופל/ת: ${step.persona.name}`;
    wrapper.appendChild(personaLine);
  }

  if (formDef.intro) {
  // Attach event listeners
    const intro = document.createElement("p");
    intro.classList.add("muted");
    intro.textContent = formDef.intro;
    wrapper.appendChild(intro);
  }

  const formEl = document.createElement("form");
  formEl.classList.add("question-list");

  const statusEl = document.createElement("div");
  statusEl.classList.add("form-status");
  statusEl.style.display = "none";
  const setStatus = (text, variant = "muted") => {
    statusEl.textContent = text;
    statusEl.className = `form-status ${variant}`;
    statusEl.style.display = text ? "block" : "none";
  };

  (formDef.statements || []).forEach((statement, index) => {
    const block = document.createElement("div");
    block.classList.add("question");
    const label = document.createElement("label");
    label.textContent = statement;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = `statement_${index}`;
    checkbox.required = true;
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
      textarea.dataset.optional = "true";
      block.appendChild(textarea);
    }

    if (item.type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.name = item.id;
      input.min = item.min ?? 0;
      input.max = item.max ?? 120;
      input.required = true;
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
        radio.required = true;
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
        checkbox.required = true;
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
        radio.required = true;
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
  wrapper.appendChild(formEl);
  wrapper.appendChild(statusEl);
  stepContainer.innerHTML = "";
  stepContainer.appendChild(wrapper);

  const applySavedResponses = (responses) => {
    (formDef.statements || []).forEach((statement, idx) => {
      const box = formEl.querySelector(`input[name="statement_${idx}"]`);
      if (!box) return;
      const val = responses[`statement_${idx}`];
      if (val !== undefined) box.checked = Boolean(val);
    });

    (formDef.items || []).forEach((item) => {
      const id = item.id;
      const type = item.type;
      const saved = responses[id];

      if (type === "text") {
        const textarea = formEl.querySelector(`textarea[name="${id}"]`);
        if (textarea && saved !== undefined && saved !== null) {
          textarea.value = String(saved);
        }
        return;
      }

      if (type === "number") {
        const input = formEl.querySelector(`input[name="${id}"]`);
        if (input && saved !== undefined && saved !== null && saved !== "") {
          input.value = saved;
        }
        return;
      }

      if (type === "single") {
        const radios = formEl.querySelectorAll(`input[name="${id}"]`);
        radios.forEach((radio) => {
          radio.checked = radio.value === String(saved);
        });
        return;
      }

      if (type === "multi") {
        const arr = Array.isArray(saved) ? saved.map(String) : saved ? [String(saved)] : [];
        const checkboxes = formEl.querySelectorAll(`input[name="${id}[]"]`);
        checkboxes.forEach((cb) => {
          cb.checked = arr.includes(cb.value);
        });
        return;
      }

      if (type === "likert") {
        const radios = formEl.querySelectorAll(`input[name="${id}"]`);
        radios.forEach((radio) => {
          radio.checked = radio.value === String(saved);
        });
      }
    });

    if (formDef.requireSignature) {
      const sigInput = formEl.querySelector("input[name=\"signature\"]");
      if (sigInput && responses.signature !== undefined && responses.signature !== null) {
        sigInput.value = String(responses.signature);
      }
    }
  };

  const gatherResponses = () => {
    const responses = {};
    const missing = [];

    (formDef.statements || []).forEach((statement, idx) => {
      const box = formEl.querySelector(`input[name="statement_${idx}"]`);
      const checked = Boolean(box?.checked);
      responses[`statement_${idx}`] = checked;
      if (!checked) missing.push(statement);
    });

    (formDef.items || []).forEach((item) => {
      const id = item.id;
      const type = item.type;

      if (type === "text") {
        const textarea = formEl.querySelector(`textarea[name="${id}"]`);
        responses[id] = textarea?.value ?? "";
        return;
      }

      if (type === "number") {
        const input = formEl.querySelector(`input[name="${id}"]`);
        const value = input?.value ?? "";
        if (!value.trim()) {
          missing.push(item.prompt || id);
          responses[id] = "";
        } else {
          responses[id] = Number(value);
        }
        return;
      }

      if (type === "single") {
        const checked = formEl.querySelector(`input[name="${id}"]:checked`);
        if (!checked) {
          missing.push(item.prompt || id);
          responses[id] = "";
        } else {
          responses[id] = checked.value;
        }
        return;
      }

      if (type === "multi") {
        const checkedBoxes = Array.from(formEl.querySelectorAll(`input[name="${id}[]"]:checked`));
        const values = checkedBoxes.map((c) => c.value);
        if (!values.length) missing.push(item.prompt || id);
        responses[id] = values;
        return;
      }

      if (type === "likert") {
        const checked = formEl.querySelector(`input[name="${id}"]:checked`);
        if (!checked) {
          missing.push(item.prompt || id);
          responses[id] = "";
        } else {
          responses[id] = Number(checked.value);
        }
      }
    });

    if (formDef.requireSignature) {
      const sig = formEl.querySelector("input[name=\"signature\"]");
      if (!sig?.value) missing.push("חתימה");
      responses.signature = sig?.value || "";
    }

    return { responses, missingRequired: missing.filter(Boolean) };
  };

  let saveInFlight = null;
  let lastSavedPayload = JSON.stringify(savedResponses || {});
  let autosaveTimeout = null;

  applySavedResponses(savedResponses || {});

  const performSave = async ({ validate = false, showErrors = false } = {}) => {
    const { responses, missingRequired } = gatherResponses();
    if (validate && missingRequired.length) {
      if (showErrors) {
        setStatus(`נא להשלים: ${missingRequired.join(" · ")}`, "error");
      }
      return false;
    }

    setStatus("שומר...", "muted");

    const payloadStr = JSON.stringify(responses);
    if (payloadStr === lastSavedPayload && saveInFlight === null && !validate) {
      setStatus("נשמר", "success");
      return true;
    }

    if (saveInFlight) {
      try {
        await saveInFlight;
      } catch (e) {
        // swallow to retry below
      }
    }

    saveInFlight = fetch(`/api/session/${state.token}/forms/${formDef.key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        responses,
        sessionPersonaId: step.sessionPersonaId || null
      })
    })
      .then(async (resp) => {
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error || "Failed to save form");
        }
        lastSavedPayload = payloadStr;
        setStatus("נשמר", "success");
        return true;
      })
      .catch((error) => {
        console.error(error);
        setStatus("שגיאה בשמירה. בדקו חיבור ונסו שוב.", "error");
        return false;
      })
      .finally(() => {
        saveInFlight = null;
      });

    return saveInFlight;
  };

  const scheduleAutosave = () => {
    if (autosaveTimeout) clearTimeout(autosaveTimeout);
    autosaveTimeout = setTimeout(() => {
      performSave({ validate: false, showErrors: false });
    }, 400);
  };

  formEl.addEventListener("input", scheduleAutosave);
  formEl.addEventListener("change", scheduleAutosave);

  activeFormController = {
    async saveAndValidate() {
      return performSave({ validate: true, showErrors: true });
    },
    teardown() {
      if (autosaveTimeout) clearTimeout(autosaveTimeout);
      activeFormController = null;
    }
  };
}

async function renderChat(step) {
  currentChatStep = step;
  stopChatTimer();
  if (midPrimeTimeout) {
    clearTimeout(midPrimeTimeout);
    midPrimeTimeout = null;
  }
  setChatLockState(false);

  const persona = step?.persona || {};
  stepContainer.innerHTML = "";

  const chatSectionEl = document.createElement("section");
  chatSectionEl.className = "chat-section";

  const intro = document.createElement("div");
  intro.classList.add("step-card");
  intro.innerHTML = `<h3>שיחת טיפול</h3><p class="muted">שיחה עם המטופל/ת הנוכחי/ת. ההודעה הראשונה מתחילה את הטיימר.</p>`;
  chatSectionEl.appendChild(intro);

  const metaRow = document.createElement("div");
  metaRow.className = "persona-meta";
  personaHeader = document.createElement("div");
  personaHeader.className = "persona-ribbon";
  personaHeader.innerHTML = `<span class="persona-name">${persona.name || "מטופל/ת"}</span><span class="persona-age">${persona.age ? `${persona.age}` : ""}</span>`;
  metaRow.appendChild(personaHeader);
  timerBadge = document.createElement("div");
  timerBadge.className = "timer-badge";
  timerBadge.textContent = "זמן שיחה: 00:00";
  metaRow.appendChild(timerBadge);
  chatSectionEl.appendChild(metaRow);

  chatWindow = document.createElement("div");
  chatWindow.className = "chat-window";
  chatWindow.id = "chat-window";
  chatWindow.setAttribute("aria-live", "polite");

  const backgroundCard = document.createElement("div");
  backgroundCard.className = "persona-background";
  const backgroundTitle = document.createElement("div");
  backgroundTitle.className = "persona-background-title";
  backgroundTitle.textContent = "רקע קצר";
  const backgroundBody = document.createElement("div");
  backgroundBody.className = "persona-background-body";
  const personaBackground = persona.background_ui || persona.background || "";
  backgroundBody.textContent = personaBackground;
  backgroundCard.appendChild(backgroundTitle);
  backgroundCard.appendChild(backgroundBody);
  chatWindow.appendChild(backgroundCard);

  chatSectionEl.appendChild(chatWindow);

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
  chatSectionEl.appendChild(chatForm);

  stepContainer.appendChild(chatSectionEl);

  // Load history
  try {
    const history = await fetchPersonaMessages(step.sessionPersonaId);
    const historyMessages = history.messages || [];
    const chatMessages = historyMessages.filter((m) => m.role === "user" || m.role === "assistant");
    chatMessages.forEach((m) => {
      appendMessage(m.role === "user" ? "user" : "assistant", m.content || "");
    });

    const firstStart = history.firstMessageAt || null;
    if (firstStart) {
      step.firstMessageAt = firstStart;
      startChatTimer(firstStart);
      scheduleMidPrime(firstStart, step.sessionPersonaId);
      const elapsed = Date.now() - new Date(firstStart).getTime();
      if (elapsed >= CHAT_DURATION_MS) {
        setChatLockState(true, `חלפו ${CHAT_DURATION_MINUTES} דקות`);
      }
    }
    updateStepNavigationVisibility(step);
    if (history.midPromptSent && timerBadge) {
      timerBadge.classList.add("timer-mid");
    }
  } catch (error) {
    appendMessage("assistant", "**שגיאה בטעינת היסטוריית הצ'אט.**");
  }

  // Attach event listeners now that elements exist
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const rawValue = messageInput.value;
    const userMessage = rawValue && rawValue.trim().length ? rawValue : "";
    if (!userMessage || chatLocked) return;
    messageInput.value = "";
    await sendChatMessage(userMessage, step);
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

  setStepIndicator();
}

async function renderFeedback(step) {
  stopChatTimer();
  if (midPrimeTimeout) {
    clearTimeout(midPrimeTimeout);
    midPrimeTimeout = null;
  }
  setChatLockState(false);
  currentChatStep = step;

  const persona = step?.persona || {};
  stepContainer.innerHTML = "";

  const card = document.createElement("div");
  card.className = "step-card feedback-card";

  const title = document.createElement("h3");
  title.textContent = `פידבק למפגש עם ${persona.name || "מטופל"}`;
  card.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.className = "muted";
  subtitle.textContent = "המסך הזה מציג את הפידבק אודות השיחה. אין אפשרות לשלוח הודעות.";
  card.appendChild(subtitle);

  const feedbackBody = document.createElement("div");
  feedbackBody.className = "feedback-body";
  feedbackBody.textContent = "טוען פידבק...";
  card.appendChild(feedbackBody);

  stepContainer.appendChild(card);

  try {
    const response = await fetch(`/api/session/${state.token}/persona/${step.sessionPersonaId}/feedback`, { method: "POST" });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err?.error || "Feedback request failed");
    }
    const data = await response.json();
    if (data.eligible === false) {
      feedbackBody.textContent = data.response || "לא ניתן לספק פידבק כי הדרישות לא מולאו.";
    } else {
      feedbackBody.innerHTML = window.marked.parse(data.response || "");
    }
  } catch (error) {
    feedbackBody.textContent = `שגיאה בטעינת הפידבק: ${error.message}`;
  }
}

async function renderCurrentStep() {
  setStepIndicator();
  stopChatTimer();
  if (midPrimeTimeout) {
    clearTimeout(midPrimeTimeout);
    midPrimeTimeout = null;
  }
  setChatLockState(false);
  // No need to hide chatSection, chatWindow, or chatForm; these are now created dynamically only for the chat step.

  const step = state.steps[state.currentStepIndex];

  if (activeFormController?.teardown) {
    activeFormController.teardown();
  }

  if (!step) {
    if (stepForwardBtn) {
      stepForwardBtn.disabled = true;
    }
    renderPlaceholder("כל השלבים הושלמו. ניתן לסגור את העמוד.");
    return;
  }

  updateStepNavigationVisibility(step);

  if (step.type === "form") {
    try {
      const [formResponse, savedResponse] = await Promise.all([
        fetch(`/api/forms/${step.key}`),
        fetchSavedFormResponses(step.key, step)
      ]);

      if (!formResponse.ok) {
        renderPlaceholder("לא נמצא טופס עבור שלב זה.");
        return;
      }

      const formDef = await formResponse.json();
      const savedResponses = savedResponse?.responses || {};
      renderForm(formDef, step, savedResponses);
    } catch (error) {
      console.error("Failed to load form", error);
      renderPlaceholder("שגיאה בטעינת הטופס, נסו לרענן את העמוד.");
    }
    return;
  }

  if (step.type === "chat") {
    await renderChat(step);
    return;
  }

  if (step.type === "module") {
    const response = await fetch(`/api/modules/${step.key}`);
    if (!response.ok) {
      renderPlaceholder("לא נמצא מודול עבור שלב זה.");
      return;
    }
    const moduleDef = await response.json();
    renderModule(moduleDef);
    return;
  }

  if (step.type === "feedback") {
    await renderFeedback(step);
    return;
  }

  renderPlaceholder("סוג שלב לא מוכר בקובץ התצורה.");
}

function renderModule(moduleDef) {
  moduleState = {
    def: moduleDef,
    chapterIndex: 0,
    pageIndex: 0,
    answered: false
  };
  drawModulePage();
}

function drawModulePage() {
  if (!moduleState?.def) return;
  const { def, chapterIndex, pageIndex } = moduleState;
  const chapter = def.chapters[chapterIndex];
  const page = chapter.pages[pageIndex];
  // Always recalculate navigation state for current chapter/page
  const lastChapter = chapterIndex === def.chapters.length - 1;
  const lastPageInChapter = pageIndex === chapter.pages.length - 1;

  stepContainer.innerHTML = "";

  const card = document.createElement("div");
  card.className = "step-card module-card";
  card.dir = "rtl";

  const header = document.createElement("div");
  header.className = "module-header";
  const title = document.createElement("h3");
  title.textContent = def.title;
  const subtitle = document.createElement("p");
  subtitle.className = "muted";
  subtitle.textContent = `פרק ${chapterIndex + 1}/${def.chapters.length} · עמוד ${pageIndex + 1}/${chapter.pages.length}`;
  header.appendChild(title);
  header.appendChild(subtitle);
  card.appendChild(header);

  const pageTitle = document.createElement("h4");
  pageTitle.textContent = page.title;
  card.appendChild(pageTitle);

  if (page.type === "info") {
    if (page.body && page.body.length) {
      page.body.forEach((p) => {
        const para = document.createElement("p");
        para.textContent = p;
        card.appendChild(para);
      });
    }
    if (page.bullets && page.bullets.length) {
      const list = document.createElement("ul");
      list.className = "module-list";
      page.bullets.forEach((b) => {
        const li = document.createElement("li");
        li.textContent = b;
        list.appendChild(li);
      });
      card.appendChild(list);
    }
    if (page.dialogue && page.dialogue.length) {
      const dlg = document.createElement("div");
      dlg.className = "module-dialogue";
      page.dialogue.forEach((line) => {
        const row = document.createElement("div");
        row.className = "dialogue-row";
        row.innerHTML = `<span class="dialogue-role">${line.role}:</span> <span>${line.text}</span>`;
        dlg.appendChild(row);
      });
      card.appendChild(dlg);
    }
    if (page.note) {
      const note = document.createElement("div");
      note.className = "module-note";
      note.textContent = page.note;
      card.appendChild(note);
    }
  }

  if (page.type === "quiz") {
    const question = document.createElement("p");
    question.className = "module-question";
    question.textContent = page.question;
    card.appendChild(question);

    const optionsWrap = document.createElement("div");
    optionsWrap.className = "module-options";
    const feedback = document.createElement("div");
    feedback.className = "module-feedback muted";
    feedback.style.display = "none";

    nextBtnRef = null;

    page.options.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-button module-option-btn";
      btn.textContent = opt;
      btn.addEventListener("click", () => {
        const isCorrect = idx === page.correctIndex;
        moduleState.answered = true;
        feedback.style.display = "block";
        feedback.textContent = isCorrect ? "נכון" : "לא נכון";
        if (page.explanation) {
          feedback.textContent += ` – ${page.explanation}`;
        }
        optionsWrap.querySelectorAll("button").forEach((b) => {
          b.disabled = true;
          b.classList.add("module-option-disabled");
        });
        if (nextBtnRef) {
          nextBtnRef.disabled = false;
        }
      });
      optionsWrap.appendChild(btn);
    });

    card.appendChild(optionsWrap);
    card.appendChild(feedback);
  }

  const footer = document.createElement("div");
  footer.className = "module-footer";

  const prevBtn = document.createElement("button");
  prevBtn.className = "ghost-button";
  prevBtn.textContent = "הקודם";
  prevBtn.disabled = chapterIndex === 0 && pageIndex === 0;
  prevBtn.addEventListener("click", () => {
    moduleState.answered = false;
    if (pageIndex > 0) {
      moduleState.pageIndex -= 1;
    } else if (chapterIndex > 0) {
      moduleState.chapterIndex -= 1;
      moduleState.pageIndex = moduleState.def.chapters[moduleState.chapterIndex].pages.length - 1;
    }
    drawModulePage();
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "ghost-button";
  const isLast = lastChapter && lastPageInChapter;
  nextBtn.textContent = isLast ? "סיום המודול" : "הבא";
  if (page.type === "quiz" && !moduleState.answered) {
    nextBtn.disabled = true;
  }
  if (page.type === "quiz") {
    nextBtnRef = nextBtn;
  }

  nextBtn.addEventListener("click", () => {
    if (page.type === "quiz" && !moduleState.answered) return;
    moduleState.answered = false;
    if (!lastPageInChapter) {
      moduleState.pageIndex += 1;
    } else if (!lastChapter) {
      moduleState.chapterIndex += 1;
      moduleState.pageIndex = 0;
    } else {
      state.currentStepIndex += 1;
      renderCurrentStep();
      return;
    }
    drawModulePage();
  });

  footer.appendChild(prevBtn);
  footer.appendChild(nextBtn);
  card.appendChild(footer);

  stepContainer.appendChild(card);
}
// Step navigation event listeners
stepBackBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  if (state.currentStepIndex > 0) {
    state.currentStepIndex--;
    renderCurrentStep();
  }
});

stepForwardBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  if (activeFormController) {
    const ok = await activeFormController.saveAndValidate();
    if (!ok) return;
  }

  // Allow advancing past the last configured step to show the finished screen.
  if (state.steps && state.currentStepIndex < state.steps.length) {
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
      if (Number(data.totalSessions) === 1) {
        statusText.textContent = `מפגש ${data.sessionNumber}`;
      } else {
        statusText.textContent = `מפגש ${data.sessionNumber} מתוך ${data.totalSessions || "?"}`;
      }
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

async function fetchPersonaMessages(sessionPersonaId) {
  const response = await fetch(`/api/session/${state.token}/persona/${sessionPersonaId}/messages`);
  if (!response.ok) {
    return { messages: [], conversationId: null, firstMessageAt: null, midPromptSent: false, feedbackPromptSent: false };
  }
  return response.json();
}

async function sendChatMessage(userMessage, step) {
  if (!step?.sessionPersonaId) {
    appendMessage("assistant", "**לא נמצא מזהה שיחה עבור המטופל הנוכחי.**");
    return;
  }

  appendMessage("user", userMessage);
  const typingIndicator = appendMessage("assistant", "*המטופל/ת כותב/ת תשובה...*");
  setLoadingState(true);

  try {
    const response = await fetch(`/api/session/${state.token}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: userMessage, sessionPersonaId: step.sessionPersonaId })
    });

    if (!response.ok) {
      const errorBody = await response.json();
      throw new Error(errorBody?.error || "Request failed");
    }

    const data = await response.json();
    state.conversationId = data.conversationId;

    if (data.firstMessageAt) {
      step.firstMessageAt = data.firstMessageAt;
      startChatTimer(data.firstMessageAt);
      scheduleMidPrime(data.firstMessageAt, step.sessionPersonaId);
    }
    updateStepNavigationVisibility(step);
    if (data.midPromptSent && timerBadge) {
      timerBadge.classList.add("timer-mid");
    }

    typingIndicator.remove();
    appendMessage("assistant", data.response || "_No response received._");
  } catch (error) {
    typingIndicator.remove();
    appendMessage("assistant", `**שגיאה בשליחה.**\n\n_${error.message}_`);
    if (error.message && error.message.includes(`${CHAT_DURATION_MINUTES} דקות`)) {
      setChatLockState(true, error.message);
      stopChatTimer();
    }
  } finally {
    setLoadingState(false);
    if (messageInput) messageInput.focus();
  }
}

// Removed top-level event listeners for chatForm and messageInput. Now attached dynamically in renderChat.
 
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
