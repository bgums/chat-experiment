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
let feedbackRenderCounter = 0;
let mobileOverrideAuthorized = false;

let moduleState = null;
// Persist nextBtnRef across renders to avoid ReferenceError
let nextBtnRef = null;

const state = {
  token,
  session: null,
  steps: [],
  currentStepIndex: 0,
  conversationId: null,
  personas: {},
  completionRequested: false,
  completionScreenRecorded: false,
  sessionAdminAuthHeader: null,
  sessionUnlockAuthorized: false
};

const CHAT_DURATION_MINUTES = 8;
const CHAT_DURATION_MS = CHAT_DURATION_MINUTES * 60 * 1000;
const MID_PROMPT_MINUTES = 9;
const MID_PROMPT_MS = MID_PROMPT_MINUTES * 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createMessageElement = (role, markdown) => {
  const wrapper = document.createElement("article");
  wrapper.classList.add("message");
  wrapper.classList.add(role === "user" ? "message-user" : "message-assistant");

  const htmlContent = safeParseMarkdown(markdown, { mangle: false, headerIds: false, breaks: true });
  wrapper.innerHTML = htmlContent;

  return wrapper;
};

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeParseMarkdown(markdown, opts) {
  // Prefer using marked when available (support both marked.parse and marked())
  try {
    if (window.marked) {
      if (typeof window.marked.parse === "function") return window.marked.parse(markdown || "", opts || {});
      if (typeof window.marked === "function") return window.marked(markdown || "");
    }
  } catch (e) {
    // fall through to simple fallback
    console.warn("marked failed, using fallback markdown parser", e);
  }

  // Minimal, safe fallback: escape HTML then convert **bold** and line breaks
  const escaped = escapeHtml(markdown || "");
  const bolded = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return bolded.replace(/\r?\n/g, "<br>");
}

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

const updateTimerBadgeText = (elapsedMs) => {
  if (!timerBadge) return;
  const clampedElapsed = Math.min(Math.max(0, elapsedMs), CHAT_DURATION_MS);
  timerBadge.textContent = `זמן שיחה: ${formatDuration(clampedElapsed)}`;
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
    const resp = await sessionApiFetch(url);
    if (!resp.ok) {
      return { responses: {} };
    }
    return await resp.json();
  } catch (error) {
    console.error("fetchSavedFormResponses failed", error);
    return { responses: {} };
  }
}

async function markSessionComplete() {
  if (!state.token || state.completionRequested) return;
  state.completionRequested = true;
  try {
    await sessionApiFetch(`/api/session/${state.token}/complete`, { method: "POST" });
  } catch (error) {
    console.warn("Failed to mark session complete", error);
  }
}

function sessionApiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.sessionAdminAuthHeader && !headers.has("Authorization")) {
    headers.set("Authorization", state.sessionAdminAuthHeader);
  }
  if (state.sessionUnlockAuthorized && !headers.has("x-session-unlock")) {
    headers.set("x-session-unlock", "1");
  }
  return fetch(url, {
    ...options,
    headers
  });
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
  const isModuleStep = step?.type === "module";
  const shouldHideForChat = isChatStep && !isChatFinished(step);
  if (shouldHideForChat || isModuleStep) {
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

  updateTimerBadgeText(Date.now() - startMs);

  chatTimerInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - startMs;
    updateTimerBadgeText(elapsed);
    if (elapsed >= limitMs) {
      updateTimerBadgeText(limitMs);
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
      await sessionApiFetch(`/api/session/${state.token}/persona/${sessionPersonaId}/mid-prime`, { method: "POST" });
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

async function loadInstructionContent(formKey) {
  if (!formKey) return null;
  try {
    const response = await fetch(`/api/forms/${formKey}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

function resolveLockFormKey(lockState, lockFormKey) {
  if (lockFormKey) return lockFormKey;
  const code = String(lockState?.code || "");
  if (code === "session_completed") return "session_locked_completion";
  if (code === "consent_expired") return "session_locked_consent_expired";
  if (code === "scheduled_time_expired") return "session_locked_scheduled_expired";
  return "session_locked_completion";
}

async function renderLockedSessionScreen(lockState, lockFormKey) {
  const content = await loadInstructionContent(resolveLockFormKey(lockState, lockFormKey));
  const titleText = content?.title || "המפגש נעול";
  const paragraphs = Array.isArray(content?.paragraphs) ? content.paragraphs : [];
  const buttonText = content?.buttonText || "כניסת מנהל";

  const wrapper = document.createElement("div");
  wrapper.classList.add("step-card");

  const title = document.createElement("h3");
  title.textContent = titleText;
  wrapper.appendChild(title);

  paragraphs.forEach((text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    wrapper.appendChild(paragraph);
  });

  const status = document.createElement("p");
  status.className = "muted";
  status.style.display = "none";
  wrapper.appendChild(status);

  const adminBtn = document.createElement("button");
  adminBtn.type = "button";
  adminBtn.className = "ghost-button";
  adminBtn.textContent = buttonText;

  adminBtn.addEventListener("click", async () => {
    const username = window.prompt("שם משתמש מנהל:", "");
    if (!username) return;
    const password = window.prompt("סיסמת מנהל:", "");
    if (!password) return;

    const basic = btoa(`${username}:${password}`);
    adminBtn.disabled = true;
    adminBtn.textContent = "בודק...";
    status.style.display = "none";

    try {
      const ok = await verifyAdminCredentials(username, password);
      if (!ok) {
        status.textContent = "פרטי מנהל שגויים. נסו שוב.";
        status.style.display = "block";
        return;
      }

      state.sessionAdminAuthHeader = `Basic ${basic}`;
      state.sessionUnlockAuthorized = true;
      await loadSession();
    } catch (error) {
      status.textContent = "בדיקת ההרשאה נכשלה. נסו שוב.";
      status.style.display = "block";
    } finally {
      adminBtn.disabled = false;
      adminBtn.textContent = buttonText;
    }
  });

  wrapper.appendChild(adminBtn);
  stepContainer.innerHTML = "";
  stepContainer.appendChild(wrapper);
}

async function renderParticipantInstruction(step) {
  const content = await loadInstructionContent(step?.key);
  const titleText = content?.title || "הנחיות";
  const paragraphs = Array.isArray(content?.paragraphs) ? content.paragraphs : [];

  const wrapper = document.createElement("div");
  wrapper.classList.add("step-card");

  const title = document.createElement("h3");
  title.textContent = titleText;
  wrapper.appendChild(title);

  paragraphs.forEach((text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    wrapper.appendChild(paragraph);
  });

  stepContainer.innerHTML = "";
  stepContainer.appendChild(wrapper);
}

async function renderSessionCompletionScreen() {
  const content = await loadInstructionContent("session_completion");
  const sessionNumber = Number(state.session?.sessionNumber || 0);
  const finalSessionNumbers = Array.isArray(content?.finalSessionNumbers)
    ? content.finalSessionNumbers.map((n) => Number(n))
    : [4];
  const isFinalSession = finalSessionNumbers.includes(sessionNumber);

  const regularContent = content?.regular || {};
  const finalContent = content?.final || {};
  const selectedContent = isFinalSession ? finalContent : regularContent;

  const titleText = selectedContent?.title || "תודה על השתתפותכם";
  const paragraphs = Array.isArray(selectedContent?.paragraphs) ? selectedContent.paragraphs : [];
  const buttonText = selectedContent?.buttonText || content?.buttonText || "אנא לחצו כאן לסיום המפגש ושליחתו";

  const wrapper = document.createElement("div");
  wrapper.classList.add("step-card");

  const title = document.createElement("h3");
  title.textContent = titleText;
  wrapper.appendChild(title);

  paragraphs.forEach((text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    wrapper.appendChild(paragraph);
  });

  const status = document.createElement("p");
  status.className = "muted";
  status.style.display = "none";
  wrapper.appendChild(status);

  const completeBtn = document.createElement("button");
  completeBtn.type = "button";
  completeBtn.className = "completion-submit-button";
  completeBtn.textContent = buttonText;

  if (!state.token || state.completionRequested) {
    completeBtn.disabled = true;
  }

  completeBtn.addEventListener("click", async () => {
    if (!state.token || state.completionRequested) return;

    completeBtn.disabled = true;
    completeBtn.textContent = "שולח...";

    try {
      if (!state.completionScreenRecorded) {
        const viewedResponse = await sessionApiFetch(`/api/session/${state.token}/completion-viewed`, { method: "POST" });
        if (viewedResponse.ok) {
          state.completionScreenRecorded = true;
        }
      }

      await markSessionComplete();
      status.textContent = "המפגש נשלח בהצלחה.";
      status.style.display = "block";
      completeBtn.textContent = buttonText;
    } catch (error) {
      status.textContent = "שליחת המפגש נכשלה. נסו שוב.";
      status.style.display = "block";
      completeBtn.disabled = false;
      completeBtn.textContent = buttonText;
    }
  });

  wrapper.appendChild(completeBtn);

  stepContainer.innerHTML = "";
  stepContainer.appendChild(wrapper);
}

function renderForm(formDef, step = {}, savedResponses = {}) {
  activeFormController = null;
  const wrapper = document.createElement("div");
  wrapper.classList.add("step-card");

  if (formDef.imageOnly && formDef.imageSrc) {
    wrapper.classList.add("image-only-card");
    const image = document.createElement("img");
    image.className = "form-image-screen";
    image.src = formDef.imageSrc;
    image.alt = formDef.imageAlt || formDef.title || "Form image";
    wrapper.appendChild(image);
    stepContainer.innerHTML = "";
    stepContainer.appendChild(wrapper);
    return;
  }

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
    const intro = document.createElement("p");
    intro.classList.add("muted");
    intro.textContent = formDef.intro;
    wrapper.appendChild(intro);
  }

  if (Array.isArray(formDef.paragraphs)) {
    formDef.paragraphs.forEach((text) => {
      const paragraph = document.createElement("p");
      paragraph.classList.add("form-paragraph");
      paragraph.textContent = text;
      wrapper.appendChild(paragraph);
    });
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
        radio.required = !!item.required;
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
        checkbox.required = !!item.required;
        optionLabel.appendChild(checkbox);
        optionLabel.appendChild(document.createTextNode(option));
        list.appendChild(optionLabel);
      });
      block.appendChild(list);
    }

    if (item.type === "likert") {
      const container = document.createElement("div");
      container.classList.add("likert-slider-container");
      
      const [min, max] = item.scale || [1, 5];
      const parsedDefault = Number(item.default);
      const midpoint = Math.round((Number(min) + Number(max)) / 2);
      const sliderDefault = Number.isFinite(parsedDefault)
        ? Math.min(max, Math.max(min, parsedDefault))
        : midpoint;
      
      const slider = document.createElement("input");
      slider.type = "range";
      slider.name = item.id;
      slider.min = min;
      slider.max = max;
      slider.step = 1;
      slider.value = String(sliderDefault);
      slider.dataset.touched = "false";
      slider.classList.add("likert-slider");
      slider.required = !!item.required;
      
      // Hidden input to ensure value is captured during form serialization if needed, 
      // but value is usually captured by name on the slider itself.
      
      const labelsRow = document.createElement("div");
      labelsRow.classList.add("likert-labels");
      labelsRow.dataset.scale = (max - min + 1);
      
      const updateBoldness = (val) => {
        labelsRow.querySelectorAll(".likert-label-item").forEach(el => {
          if (el.dataset.value === String(val)) {
            el.classList.add("selected");
          } else {
            el.classList.remove("selected");
          }
        });
      };

      for (let value = min; value <= max; value += 1) {
        const labelItem = document.createElement("div");
        labelItem.classList.add("likert-label-item");
        labelItem.dataset.value = value;
        
        const numSpan = document.createElement("span");
        numSpan.className = "likert-num";
        numSpan.textContent = value;
        
        const textSpan = document.createElement("span");
        textSpan.className = "likert-text";
        textSpan.textContent = item.labels?.[value] || "";
        
        labelItem.appendChild(numSpan);
        labelItem.appendChild(textSpan);
        labelsRow.appendChild(labelItem);
      }
      
      slider.addEventListener("input", (e) => {
        e.target.dataset.touched = "true";
        updateBoldness(e.target.value);
      });
      slider.addEventListener("change", (e) => {
        e.target.dataset.touched = "true";
      });
      
      // Auto-set the initial boldness after a short delay to ensure rendering is complete
      setTimeout(() => updateBoldness(slider.value), 0);

      // Initial state
      if (item.required) {
        // If required and no saved response, we might want a default or just wait for first touch.
        // For sliders, they always have a value (usually middle).
      }

      container.appendChild(slider);
      container.appendChild(labelsRow);
      block.appendChild(container);
      
      // Store a reference to update boldness when responses are applied
      container._updateBoldness = updateBoldness;
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
        const slider = formEl.querySelector(`input[name="${id}"]`);
        if (slider && saved !== undefined && saved !== null && saved !== "") {
          slider.value = String(saved);
          const container = slider.closest(".likert-slider-container");
          if (container && container._updateBoldness) {
            container._updateBoldness(saved);
          }
          // mark as touched when a saved response was applied
          slider.dataset.touched = "true";
        }
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
        if (item.required && !values.length) missing.push(item.prompt || id);
        responses[id] = values;
        return;
      }

      if (type === "likert") {
        const slider = formEl.querySelector(`input[name="${id}"]`);
        if (!slider) {
          responses[id] = "";
        } else {
          // Determine midpoint for the slider range
          const min = Number(slider.min || 1);
          const max = Number(slider.max || 5);
          const midpoint = Math.round((min + max) / 2);
          const val = Number(slider.value);
          // If the user never touched the slider and it remains on the midpoint,
          // explicitly record the midpoint (e.g., 3 for a 1-5 scale).
          if (slider.dataset.touched !== "true" && val === midpoint) {
            responses[id] = midpoint;
          } else {
            responses[id] = val;
          }
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

    saveInFlight = sessionApiFetch(`/api/session/${state.token}/forms/${formDef.key}`, {
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
  intro.innerHTML = `<h3>שיחת טיפול</h3><p class="muted">לרשותכם 8 דקות לשיחה עם המטופל/ת. במידה והשיחה גורמת לכם לאי נעימות מכל סיבה, תוכלו לצאת מהניסוי בכל שלב.</p>`;
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
  backgroundTitle.textContent = "רקע";
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
        updateTimerBadgeText(CHAT_DURATION_MS);
        setChatLockState(true, `חלפו ${CHAT_DURATION_MINUTES} דקות`);
        stopChatTimer();
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

async function renderFeedback(step, renderId) {
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

  let retryDelayMs = 1500;
  const maxWaitMs = 3 * 60 * 1000;
  const waitStartedAt = Date.now();
  const timeoutMessage = "ישנה בעיה עם טעינת הפידבק - אנא פנו למאיה סלומון במייל Salomonm@post.bgu.ac.il";

  for (;;) {
    if (renderId !== feedbackRenderCounter) {
      return;
    }

    if (Date.now() - waitStartedAt >= maxWaitMs) {
      feedbackBody.textContent = timeoutMessage;
      return;
    }

    try {
      const response = await sessionApiFetch(`/api/session/${state.token}/persona/${step.sessionPersonaId}/feedback`, { method: "POST" });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error || "Feedback request failed");
      }

      if (data?.pending || data?.ready === false) {
        const nextPollMs = Math.max(500, Number(data?.pollAfterMs) || 2000);
        feedbackBody.textContent = "טוען פידבק...";
        await wait(nextPollMs);
        continue;
      }

      if (data.eligible === false) {
        feedbackBody.textContent = data.response || "לא ניתן לספק פידבק כי הדרישות לא מולאו.";
      } else {
        feedbackBody.innerHTML = window.marked.parse(data.response || "");
      }
      return;
    } catch (error) {
      feedbackBody.textContent = "טוען פידבק...";
      await wait(retryDelayMs);
      retryDelayMs = Math.min(15000, Math.floor(retryDelayMs * 1.5));
    }
  }
}

async function renderCurrentStep() {
  feedbackRenderCounter += 1;
  const renderId = feedbackRenderCounter;
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
    await renderSessionCompletionScreen();
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

  if (step.type === "participant_instruction") {
    await renderParticipantInstruction(step);
    return;
  }

  if (step.type === "module") {
    await renderModule(step);
    return;
  }

  if (step.type === "feedback") {
    await renderFeedback(step, renderId);
    return;
  }

  renderPlaceholder("סוג שלב לא מוכר בקובץ התצורה.");
}

async function renderModule(step) {
  stopChatTimer();
  if (midPrimeTimeout) {
    clearTimeout(midPrimeTimeout);
    midPrimeTimeout = null;
  }
  setChatLockState(false);

  if (!step?.key) {
    renderPlaceholder("לא הוגדר מפתח מודול לשלב זה.");
    return;
  }

  // Detect consecutive module steps and, when multiple module steps appear
  // in sequence (e.g., an intro module followed by another module), load
  // and merge them so the participant sees a unified sequence of sections.
  const moduleSteps = [];
  for (let i = state.currentStepIndex; i < state.steps.length; i += 1) {
    const s = state.steps[i];
    if (s?.type === "module") moduleSteps.push(s);
    else break;
  }

  if (moduleSteps.length <= 1) {
    const moduleResp = await fetch(`/api/modules/${step.key}`);
    if (!moduleResp.ok) {
      renderPlaceholder("לא נמצא מודול עבור שלב זה.");
      return;
    }
    const moduleDef = await moduleResp.json();

    if (Array.isArray(moduleDef?.sections)) {
      await renderSectionModule(step, moduleDef);
      return;
    }

    moduleState = {
      def: moduleDef,
      chapterIndex: 0,
      pageIndex: 0,
      answered: false
    };
    drawLegacyModulePage();
    return;
  }

  // Multiple module steps: fetch all module defs and merge sections
  const moduleKeys = moduleSteps.map((ms) => ms.key);
  const defs = await Promise.all(
    moduleKeys.map((k) => fetch(`/api/modules/${k}`).then((r) => (r.ok ? r.json() : null)))
  );

  if (defs.some((d) => !d)) {
    renderPlaceholder("לא ניתן לטעון את אחד ממודולי הסשן.");
    return;
  }

  // Build combined sections and keep metadata which module key each section came from
  const combinedSections = [];
  defs.forEach((def, defIdx) => {
    const key = moduleKeys[defIdx];
    const moduleTitle = def?.module_title || def?.title || null;
    const secs = Array.isArray(def.sections) ? def.sections : [];
    secs.forEach((sec) => {
      // attach internal metadata (non-serializable) to track origin module
      const secClone = Object.assign({}, sec);
      secClone.__moduleKey = key;
      secClone.__moduleTitle = moduleTitle;
      combinedSections.push(secClone);
    });
  });

  await renderCombinedSectionModule(step, combinedSections, moduleKeys.length);
}

function getQuestionId(section, question, index) {
  const raw = question?.question_id;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    return String(raw);
  }
  return `${String(section?.section_id || "")}__q${index + 1}`;
}

async function renderCombinedSectionModule(step, sections, moduleStepCount) {
  // Aggregate responses for all involved modules
  const moduleKeys = Array.from(new Set(sections.map((s) => s.__moduleKey)));
  const responsesList = await Promise.all(
    moduleKeys.map((k) => sessionApiFetch(`/api/session/${state.token}/modules/${k}/responses`).then((r) => (r.ok ? r.json() : { responses: [] })))
  );
  const responses = responsesList.flatMap((p) => p.responses || []);
  const responseMap = new Map(responses.map((row) => [`${String(row.sectionId)}::${String(row.questionId)}`, row]));

  const sectionsSorted = [...sections];

  // Detect if this page load was a reload. On a reload we want to start
  // participants at the first screen so they must navigate back manually.
  const navEntries = (performance && typeof performance.getEntriesByType === "function")
    ? performance.getEntriesByType("navigation")
    : null;
  const isReload = (navEntries && navEntries[0] && navEntries[0].type === "reload") ||
    (performance && performance.navigation && performance.navigation.type === 1);

  let activeSectionIndex = 0;
  const firstUnansweredIdx = sectionsSorted.findIndex((section) => {
    const questions = section.questions || [];
    return questions.some((question, idx) => !responseMap.has(`${section.section_id}::${getQuestionId(section, question, idx)}`));
  });
  // Only resume to the first-unanswered when this is not a page reload
  if (!isReload && responses.length > 0 && firstUnansweredIdx >= 0) activeSectionIndex = firstUnansweredIdx;

  const drawSection = () => {
    const section = sectionsSorted[activeSectionIndex];
    const questions = section.questions || [];
    const card = document.createElement("div");
    card.className = "step-card module-card";

    const title = document.createElement("h3");
    title.textContent = section.__moduleTitle || step?.moduleTitle || "מודול";
    card.appendChild(title);

    const sectionTitle = document.createElement("h4");
    sectionTitle.textContent = section.title || `Section ${activeSectionIndex + 1}`;
    card.appendChild(sectionTitle);

    (section.content || []).forEach((paragraph) => {
      const paraEl = document.createElement("div");
      paraEl.className = "module-content-paragraph";
      paraEl.innerHTML = safeParseMarkdown(String(paragraph || ""), { mangle: false, headerIds: false, breaks: true });
      card.appendChild(paraEl);
    });

    questions.forEach((question, idx) => {
      const questionNumber = idx + 1;
      const resolvedQuestionId = getQuestionId(section, question, idx);
      const responseKey = `${section.section_id}::${resolvedQuestionId}`;
      const existing = responseMap.get(responseKey);
      const answerLocked = Boolean(existing);
      const selectedAnswer = existing?.answer;
      const correctIndex = Number.isInteger(question.correct_answer_index) ? Number(question.correct_answer_index) : null;
      const correctAnswer = correctIndex != null ? question.options?.[correctIndex] : null;

      const questionBlock = document.createElement("div");
      questionBlock.className = "question module-question-block";

      const prompt = document.createElement("p");
      prompt.className = "module-question";
      prompt.textContent = `${question.prompt || resolvedQuestionId}`;
      questionBlock.appendChild(prompt);

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "module-options";
      const statusText = document.createElement("p");
      statusText.className = "muted module-feedback";
      (question.options || []).forEach((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost-button module-option-btn";
        button.textContent = option;

        if (answerLocked) {
          button.disabled = true;
          const isSelected = selectedAnswer === option;
          const isCorrectOption = correctAnswer != null && correctAnswer === option;
          if (isCorrectOption) {
            button.classList.add("module-option-correct");
          }
          if (isSelected && !isCorrectOption) {
            button.classList.add("module-option-wrong");
          }
          if (isSelected && correctAnswer == null) {
            button.classList.add("module-option-selected");
          }
        } else {
          button.addEventListener("click", async () => {
            const optionButtons = Array.from(optionsWrap.querySelectorAll(".module-option-btn"));
            optionButtons.forEach((candidate) => {
              candidate.disabled = true;
              candidate.classList.remove("module-option-selected");
            });
            button.classList.add("module-option-selected");
            statusText.textContent = "";
            try {
              const payload = {
                sectionId: section.section_id,
                sectionNumber: Number(section.order_number || activeSectionIndex + 1),
                questionId: resolvedQuestionId,
                questionNumber,
                questionContent: question.prompt || resolvedQuestionId,
                answer: option,
                correctAnswer
              };
              const saveResp = await sessionApiFetch(`/api/session/${state.token}/modules/${section.__moduleKey}/answer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
              });

              if (!saveResp.ok) {
                const err = await saveResp.json().catch(() => ({}));
                throw new Error(err?.error || "Could not save answer");
              }

              const saveData = await saveResp.json();
              responseMap.set(responseKey, {
                sectionId: section.section_id,
                questionId: resolvedQuestionId,
                answer: option,
                correctAnswer,
                isCorrect: saveData?.isCorrect
              });
              drawSection();
            } catch (error) {
              console.error(error);
              statusText.textContent = "לא ניתן לשמור את התשובה כרגע. נסו שוב.";
              optionButtons.forEach((candidate) => {
                candidate.disabled = false;
              });
            }
          });
        }
        optionsWrap.appendChild(button);
      });
      questionBlock.appendChild(optionsWrap);
      questionBlock.appendChild(statusText);
      card.appendChild(questionBlock);
    });

    const footer = document.createElement("div");
    footer.className = "module-footer";
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "ghost-button";
    prevBtn.textContent = "הקודם";
    prevBtn.disabled = activeSectionIndex === 0;
    prevBtn.addEventListener("click", () => {
      if (activeSectionIndex > 0) {
        activeSectionIndex -= 1;
        drawSection();
      }
    });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "ghost-button";
    const isLast = activeSectionIndex === sectionsSorted.length - 1;
    nextBtn.textContent = isLast ? "המשך לשלב הבא" : "הבא";

    const hasPendingQuestions = questions.some(
      (question, idx) => !responseMap.has(`${section.section_id}::${getQuestionId(section, question, idx)}`)
    );
    nextBtn.disabled = hasPendingQuestions;

    nextBtn.addEventListener("click", async () => {
      if (hasPendingQuestions) return;
      if (!isLast) {
        activeSectionIndex += 1;
        drawSection();
      } else {
        // Advance by the number of module steps we merged
        state.currentStepIndex += moduleStepCount;
        await renderCurrentStep();
      }
    });

    footer.appendChild(prevBtn);
    footer.appendChild(nextBtn);
    card.appendChild(footer);

    stepContainer.innerHTML = "";
    stepContainer.appendChild(card);
  };

  drawSection();
}

async function renderSectionModule(step, moduleDef) {
  const responsesResp = await sessionApiFetch(`/api/session/${state.token}/modules/${step.key}/responses`);
  const responsesPayload = responsesResp.ok ? await responsesResp.json() : { responses: [] };
  const responses = responsesPayload.responses || [];

  const responseMap = new Map(
    responses.map((row) => [`${String(row.sectionId)}::${String(row.questionId)}`, row])
  );

  const sections = [...(moduleDef.sections || [])].sort(
    (a, b) => Number(a.order_number || 0) - Number(b.order_number || 0)
  );

  if (!sections.length) {
    renderPlaceholder("המודול ריק.");
    return;
  }

  // Detect page reload and, if so, force start at the first section so the
  // participant must navigate back to their prior position manually.
  const navEntries = (performance && typeof performance.getEntriesByType === "function")
    ? performance.getEntriesByType("navigation")
    : null;
  const isReload = (navEntries && navEntries[0] && navEntries[0].type === "reload") ||
    (performance && performance.navigation && performance.navigation.type === 1);

  let activeSectionIndex = 0;
  const firstUnansweredIdx = sections.findIndex((section) => {
    const questions = section.questions || [];
    return questions.some((question, idx) => !responseMap.has(`${section.section_id}::${getQuestionId(section, question, idx)}`));
  });
  if (!isReload && responses.length > 0 && firstUnansweredIdx >= 0) activeSectionIndex = firstUnansweredIdx;

  const drawSection = () => {
    const section = sections[activeSectionIndex];
    const questions = section.questions || [];
    const card = document.createElement("div");
    card.className = "step-card module-card";

    const title = document.createElement("h3");
    title.textContent = moduleDef.module_title || moduleDef.title || "מודול";
    card.appendChild(title);

    const sectionTitle = document.createElement("h4");
    sectionTitle.textContent = section.title || `Section ${activeSectionIndex + 1}`;
    card.appendChild(sectionTitle);

    (section.content || []).forEach((paragraph) => {
      const paraEl = document.createElement("div");
      paraEl.className = "module-content-paragraph";
      paraEl.innerHTML = window.marked.parse(String(paragraph || ""), { mangle: false, headerIds: false, breaks: true });
      card.appendChild(paraEl);
    });

    questions.forEach((question, idx) => {
      const questionNumber = idx + 1;
      const resolvedQuestionId = getQuestionId(section, question, idx);
      const responseKey = `${section.section_id}::${resolvedQuestionId}`;
      const existing = responseMap.get(responseKey);
      const answerLocked = Boolean(existing);
      const selectedAnswer = existing?.answer;
      const correctIndex = Number.isInteger(question.correct_answer_index) ? Number(question.correct_answer_index) : null;
      const correctAnswer = correctIndex != null ? question.options?.[correctIndex] : null;

      const questionBlock = document.createElement("div");
      questionBlock.className = "question module-question-block";

      const prompt = document.createElement("p");
      prompt.className = "module-question";
      prompt.textContent = `${question.prompt || resolvedQuestionId}`;
      questionBlock.appendChild(prompt);

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "module-options";
      const statusText = document.createElement("p");
      statusText.className = "muted module-feedback";
      (question.options || []).forEach((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost-button module-option-btn";
        button.textContent = option;

        if (answerLocked) {
          button.disabled = true;
          const isSelected = selectedAnswer === option;
          const isCorrectOption = correctAnswer != null && correctAnswer === option;
          if (isCorrectOption) {
            button.classList.add("module-option-correct");
          }
          if (isSelected && !isCorrectOption) {
            button.classList.add("module-option-wrong");
          }
          if (isSelected && correctAnswer == null) {
            button.classList.add("module-option-selected");
          }
        } else {
          button.addEventListener("click", async () => {
            const optionButtons = Array.from(optionsWrap.querySelectorAll(".module-option-btn"));
            optionButtons.forEach((candidate) => {
              candidate.disabled = true;
              candidate.classList.remove("module-option-selected");
            });
            button.classList.add("module-option-selected");
            statusText.textContent = "";
            try {
              const payload = {
                sectionId: section.section_id,
                sectionNumber: Number(section.order_number || activeSectionIndex + 1),
                questionId: resolvedQuestionId,
                questionNumber,
                questionContent: question.prompt || resolvedQuestionId,
                answer: option,
                correctAnswer
              };
              const saveResp = await sessionApiFetch(`/api/session/${state.token}/modules/${step.key}/answer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
              });

              if (!saveResp.ok) {
                const err = await saveResp.json().catch(() => ({}));
                throw new Error(err?.error || "Could not save answer");
              }

              const saveData = await saveResp.json();
              responseMap.set(responseKey, {
                sectionId: section.section_id,
                questionId: resolvedQuestionId,
                answer: option,
                correctAnswer,
                isCorrect: saveData?.isCorrect
              });
              drawSection();
            } catch (error) {
              console.error(error);
              statusText.textContent = "לא ניתן לשמור את התשובה כרגע. נסו שוב.";
              optionButtons.forEach((candidate) => {
                candidate.disabled = false;
              });
            }
          });
        }
        optionsWrap.appendChild(button);
      });
      questionBlock.appendChild(optionsWrap);
      questionBlock.appendChild(statusText);
      card.appendChild(questionBlock);
    });

    const footer = document.createElement("div");
    footer.className = "module-footer";
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "ghost-button";
    prevBtn.textContent = "הקודם";
    prevBtn.disabled = activeSectionIndex === 0;
    prevBtn.addEventListener("click", () => {
      if (activeSectionIndex > 0) {
        activeSectionIndex -= 1;
        drawSection();
      }
    });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "ghost-button";
    const isLast = activeSectionIndex === sections.length - 1;
    nextBtn.textContent = isLast ? "המשך לשלב הבא" : "הבא";

    const hasPendingQuestions = questions.some(
      (question, idx) => !responseMap.has(`${section.section_id}::${getQuestionId(section, question, idx)}`)
    );
    nextBtn.disabled = hasPendingQuestions;

    nextBtn.addEventListener("click", async () => {
      if (hasPendingQuestions) return;
      if (!isLast) {
        activeSectionIndex += 1;
        drawSection();
      } else {
        state.currentStepIndex += 1;
        await renderCurrentStep();
      }
    });

    footer.appendChild(prevBtn);
    footer.appendChild(nextBtn);
    card.appendChild(footer);

    stepContainer.innerHTML = "";
    stepContainer.appendChild(card);
  };

  drawSection();
}

function drawLegacyModulePage() {
  if (!moduleState?.def) return;
  const { def, chapterIndex, pageIndex } = moduleState;
  const chapter = def.chapters[chapterIndex];
  const page = chapter.pages[pageIndex];
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
    drawLegacyModulePage();
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "ghost-button";
  const isLast = lastChapter && lastPageInChapter;
  nextBtn.textContent = isLast ? "המשך לשלב הבא" : "הבא";
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
    drawLegacyModulePage();
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
    const response = await sessionApiFetch(`/api/session/${state.token}`);
    if (!response.ok) {
      renderPlaceholder("לא נמצא מפגש עבור הקישור הזה.");
      statusText.textContent = "קישור לא תקין. פנו לחוקר לקבלת קישור חדש.";
      return;
    }

    const data = await response.json();
    if (data?.locked) {
      state.session = null;
      state.steps = [];
      if (statusText) {
        statusText.textContent = "המפגש נעול";
      }
      if (sessionLabel) {
        sessionLabel.textContent = "המפגש נעול";
      }
      await renderLockedSessionScreen(data.lockState, data.lockFormKey);
      return;
    }

    state.session = data;
    state.steps = data.steps || [];
    state.completionRequested = false;
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
  const response = await sessionApiFetch(`/api/session/${state.token}/persona/${sessionPersonaId}/messages`);
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
    const response = await sessionApiFetch(`/api/session/${state.token}/message`, {
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

function isSmartphoneDevice() {
  const ua = String(navigator.userAgent || "").toLowerCase();
  const phonePattern = /(iphone|ipod|windows phone|iemobile|opera mini|blackberry|bb10|webos|android.+mobile)/i;
  const looksLikePhone = phonePattern.test(ua);
  const narrowViewport = window.matchMedia("(max-width: 820px)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const explicitTablet = /(ipad|tablet)/i.test(ua);
  return looksLikePhone || (coarsePointer && narrowViewport && !explicitTablet);
}

async function verifyAdminCredentials(username, password) {
  const basic = btoa(`${username}:${password}`);
  const response = await fetch("/api/admin/session-options", {
    headers: {
      Authorization: `Basic ${basic}`
    }
  });
  return response.ok;
}

function renderSmartphoneBlockedScreen() {
  const wrapper = document.createElement("div");
  wrapper.className = "step-card mobile-block-card";

  const title = document.createElement("h3");
  title.textContent = "פתיחת האתר בסמארטפון אינה מותרת";
  wrapper.appendChild(title);

  const message = document.createElement("p");
  message.className = "muted";
  message.textContent = "יש לפתוח את האתר ממחשב או טאבלט. מנהל יכול להמשיך בכל זאת באמצעות שם משתמש וסיסמה.";
  wrapper.appendChild(message);

  const adminBtn = document.createElement("button");
  adminBtn.type = "button";
  adminBtn.className = "ghost-button";
  adminBtn.textContent = "כניסת מנהל";

  adminBtn.addEventListener("click", async () => {
    const username = window.prompt("שם משתמש מנהל:", "");
    if (!username) return;
    const password = window.prompt("סיסמת מנהל:", "");
    if (!password) return;

    adminBtn.disabled = true;
    adminBtn.textContent = "בודק...";
    try {
      const ok = await verifyAdminCredentials(username, password);
      if (!ok) {
        message.textContent = "פרטי מנהל שגויים. נסו שוב או היכנסו ממחשב/טאבלט.";
      } else {
        mobileOverrideAuthorized = true;
        message.textContent = "הזדהות מנהל הצליחה. טוען את המפגש...";
        loadSession();
        return;
      }
    } catch (error) {
      message.textContent = "בדיקת ההרשאה נכשלה. נסו שוב.";
    } finally {
      adminBtn.disabled = false;
      adminBtn.textContent = "כניסת מנהל";
    }
  });

  wrapper.appendChild(adminBtn);
  stepContainer.innerHTML = "";
  stepContainer.appendChild(wrapper);
}

// Removed top-level event listeners for chatForm and messageInput. Now attached dynamically in renderChat.
 
function initialize() {
  participantPanel.hidden = false;

  if (isSmartphoneDevice() && !mobileOverrideAuthorized) {
    renderSmartphoneBlockedScreen();
    if (sessionLabel) {
      sessionLabel.textContent = "מכשיר לא נתמך";
    }
    return;
  }

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
