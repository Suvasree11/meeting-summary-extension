const PAGE_SOURCE = "meetmind-app";
const EXT_SOURCE = "meetmind-extension";

function postToPage(message) {
  window.postMessage({ source: EXT_SOURCE, ...message }, "*");
}

function extensionUnavailableMessage(error) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (text.includes("Extension context invalidated")) {
    return "MeetMind extension was reloaded. Refresh this page, then try again.";
  }
  if (text.includes("Receiving end does not exist")) {
    return "MeetMind extension is not running. Reload the extension at chrome://extensions and refresh this page.";
  }
  if (text.includes("message port closed")) {
    return "MeetMind extension stopped responding. Refresh this page and try again.";
  }
  return text || "Could not reach the MeetMind extension.";
}

async function relayToBackground(data) {
  if (!chrome.runtime?.id) {
    postToPage({ type: "CAPTURE_ERROR", error: extensionUnavailableMessage(new Error("Extension context invalidated")) });
    return;
  }

  const payload = {
    source: PAGE_SOURCE,
    type: data.type,
    meetingId: data.meetingId,
    meetingUrl: data.meetingUrl ?? null,
    token: data.token,
    wsBase: data.wsBase,
    targetTabId: data.targetTabId ?? null,
    reason: data.reason ?? null,
    sessionId: data.sessionId ?? null
  };

  // #region agent log
  fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
    body: JSON.stringify({
      sessionId: "b5045b",
      hypothesisId: "F",
      location: "content-script.js:relayToBackground",
      message: "relayToBackground send",
      data: { type: payload.type, hasMeetingId: Boolean(payload.meetingId) },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (response && response.ok === false) {
      postToPage({ type: "CAPTURE_ERROR", error: response.error ?? "Capture request failed." });
    }
  } catch (error) {
    // #region agent log
    fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
      body: JSON.stringify({
        sessionId: "b5045b",
        hypothesisId: "F",
        location: "content-script.js:relayToBackground",
        message: "relayToBackground error",
        data: { type: payload.type, error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion

    postToPage({ type: "CAPTURE_ERROR", error: extensionUnavailableMessage(error) });
  }
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE) return;

  if (data.type === "MEETMIND_PING") {
    postToPage({ type: "CAPTURE_READY" });
    return;
  }

  if (data.type === "MEETMIND_START_CAPTURE" || data.type === "MEETMIND_STOP_CAPTURE") {
    void relayToBackground(data);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== EXT_SOURCE) return;
  postToPage(message);
});

postToPage({ type: "CAPTURE_READY" });
