const chatWindow = document.getElementById("chat-window");
const form = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");

let conversationId = null;

const createMessageElement = (role, markdown) => {
  const wrapper = document.createElement("article");
  wrapper.classList.add("message");
  wrapper.classList.add(role === "user" ? "message-user" : "message-assistant");

  const htmlContent = window.marked.parse(markdown, { mangle: false, headerIds: false });
  wrapper.innerHTML = htmlContent;

  return wrapper;
};

const appendMessage = (role, markdown) => {
  const messageElement = createMessageElement(role, markdown);
  chatWindow.appendChild(messageElement);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return messageElement;
};

const setLoadingState = (isLoading) => {
  sendButton.disabled = isLoading;
  messageInput.disabled = isLoading;
  if (isLoading) {
    sendButton.textContent = "שולח";
  } else {
    sendButton.textContent = "שלח";
  }
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const userMessage = messageInput.value.trim();

  if (!userMessage) {
    return;
  }

  appendMessage("user", userMessage);
  messageInput.value = "";
  setLoadingState(true);

  const typingIndicator = appendMessage("assistant", "*המטופל/ת כותב/ת תשובה...*");

  try {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: userMessage,
        conversationId
      })
    });

    if (!response.ok) {
      const errorBody = await response.json();
      throw new Error(errorBody?.error || "Request failed");
    }

    const data = await response.json();
    conversationId = data.conversationId;

    typingIndicator.remove();
    appendMessage("assistant", data.response || "_No response received._");
  } catch (error) {
    typingIndicator.remove();
    appendMessage("assistant", `**Sorry, something went wrong.**\n\n_${error.message}_`);
  } finally {
    setLoadingState(false);
    messageInput.focus();
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    form.requestSubmit();
  }

  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    const { selectionStart, selectionEnd, value } = messageInput;
    messageInput.value = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`;
    const caretPosition = selectionStart + 1;
    messageInput.setSelectionRange(caretPosition, caretPosition);
  }
});
