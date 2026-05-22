const EXT_SOURCE = "meetmind-extension";

/** Host patterns for automatic meeting-tab detection. */
const MEETING_URL_RE =
  /meet\.google\.com|loom\.com\/(?:share|embed)|(?:^|\/\/)(?:[\w-]+\.)?zoom\.us\/(?:j|wc|my)\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/l\/meetup-join/i;

let captureSession = null;
let captureOpId = 0;
let offscreenEnsurePromise = null;

function isMeetingUrl(url) {
  if (!url) return false;
  try {
    return MEETING_URL_RE.test(url);
  } catch {
    return false;
  }
}

function meetingHostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "meeting tab";
  }
}

function canonicalMeetingUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function isSameMeetingUrl(left, right) {
  const a = canonicalMeetingUrl(left);
  const b = canonicalMeetingUrl(right);
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

async function forwardToOwner(message) {
  const ownerTabId = captureSession?.ownerTabId;
  if (!ownerTabId) return;
  try {
    await chrome.tabs.sendMessage(ownerTabId, { source: EXT_SOURCE, ...message });
  } catch {
    // App tab may have reloaded; capture can continue until explicit stop.
  }
}

async function offscreenDocumentExists() {
  if (!chrome.runtime.getContexts) return false;
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (offscreenEnsurePromise) return offscreenEnsurePromise;

  offscreenEnsurePromise = (async () => {
    if (await offscreenDocumentExists()) return;

    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: "Capture meeting tab audio, play it locally while recording, and stream transcripts to MeetMind."
      });
    } catch (error) {
      if (error instanceof Error && /single offscreen document|Only a single offscreen document/i.test(error.message)) {
        return;
      }
      throw error;
    }
  })();

  try {
    await offscreenEnsurePromise;
  } finally {
    offscreenEnsurePromise = null;
  }
}

async function closeOffscreenWhenIdle() {
  if (captureSession) return;
  if (!(await offscreenDocumentExists())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Document may already be closing.
  }
}

async function stopCapture(reason = "manual-stop", detail = "Capture stopped.") {
  const session = captureSession;
  if (!session) return;

  const opId = ++captureOpId;
  captureSession = null;

  // #region agent log
  fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
    body: JSON.stringify({
      sessionId: "b5045b",
      hypothesisId: "A",
      location: "background.js:stopCapture",
      message: "stopCapture invoked",
      data: { sessionId: session.sessionId, reason, opId },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  await forwardToOwner({
    type: "CAPTURE_STATUS",
    status: "stopping",
    detail,
    sessionId: session.sessionId
  });

  try {
    await chrome.runtime.sendMessage({
      source: EXT_SOURCE,
      type: "STOP_CAPTURE",
      sessionId: session.sessionId,
      reason
    });
  } catch {
    // Offscreen may already be gone.
  }

  if (opId === captureOpId) {
    await forwardToOwner({ type: "CAPTURE_STOPPED", sessionId: session.sessionId, reason });
  }

  void closeOffscreenWhenIdle();
}

async function findMeetingTab(preferredTabId, preferredUrl) {
  if (preferredTabId) {
    const tab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (tab?.id) return tab;
  }

  const tabs = await chrome.tabs.query({});
  const matchingUrl = preferredUrl
    ? tabs.find((tab) => isMeetingUrl(tab.url) && isSameMeetingUrl(tab.url, preferredUrl))
    : null;
  if (matchingUrl) return matchingUrl;

  const activeMeeting = tabs.find((tab) => tab.active && isMeetingUrl(tab.url));
  if (activeMeeting) return activeMeeting;
  return tabs.find((tab) => isMeetingUrl(tab.url)) ?? null;
}

async function startCapture({ ownerTabId, meetingId, meetingUrl, token, wsBase, targetTabId }) {
  const opId = ++captureOpId;

  if (captureSession) {
    await stopCapture("superseded", "Stopping previous capture before starting a new one.");
    if (opId !== captureOpId) return;
  }

  const meetingTab = await findMeetingTab(targetTabId, meetingUrl);
  if (!meetingTab?.id) {
    await chrome.tabs.sendMessage(ownerTabId, {
      source: EXT_SOURCE,
      type: "CAPTURE_ERROR",
      error:
        "No meeting tab found. Open Google Meet, Zoom, Teams, or Loom, or use browser tab sharing from the app."
    }).catch(() => null);
    return;
  }

  await ensureOffscreen();

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: meetingTab.id,
      suppressLocalAudioPlayback: false
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Tab capture permission denied.";
    await chrome.tabs.sendMessage(ownerTabId, {
      source: EXT_SOURCE,
      type: "CAPTURE_ERROR",
      error: msg
    }).catch(() => null);
    return;
  }

  if (opId !== captureOpId) return;

  const sessionId = `${meetingId}:${meetingTab.id}`;
  captureSession = {
    sessionId,
    ownerTabId,
    meetingTabId: meetingTab.id,
    meetingTabUrl: meetingTab.url ?? "",
    meetingTabTitle: meetingTab.title ?? "",
    meetingId,
    token,
    wsBase,
    streamId,
    reconnectCount: 0,
    opId
  };

  // #region agent log
  fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
    body: JSON.stringify({
      sessionId: "b5045b",
      hypothesisId: "B",
      location: "background.js:startCapture",
      message: "START_CAPTURE dispatch",
      data: { sessionId, meetingTabId: meetingTab.id, opId },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  await chrome.runtime.sendMessage({
    source: EXT_SOURCE,
    type: "START_CAPTURE",
    session: captureSession
  });

  await forwardToOwner({
    sessionId,
    type: "CAPTURE_STATUS",
    status: "starting",
    detail: `Capturing audio from ${meetingTab.title || meetingHostLabel(meetingTab.url ?? "")}`
  });
}

chrome.runtime.onStartup.addListener(() => {
  captureSession = null;
  captureOpId += 1;
});

chrome.runtime.onInstalled.addListener(() => {
  captureSession = null;
  captureOpId += 1;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source === "meetmind-meeting") {
    if (!captureSession || captureSession.meetingTabId !== sender.tab?.id) return;
    if (message.type === "PARTICIPANTS") {
      void chrome.runtime.sendMessage({
        source: EXT_SOURCE,
        type: "PARTICIPANT_UPDATE",
        sessionId: captureSession.sessionId,
        participants: message.participants
      }).catch(() => null);
    }
    if (message.type === "MEETING_UNLOAD") {
      void stopCapture("meeting-page-unload", "The meeting page unloaded.");
    }
    return;
  }

  if (!message || message.source !== "meetmind-app") return;

  if (message.type === "MEETMIND_STOP_CAPTURE") {
    void stopCapture(message.reason ?? "manual-stop", "Capture stopped.")
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Failed to stop capture." })
      );
    return true;
  }

  if (message.type !== "MEETMIND_START_CAPTURE") return;

  const ownerTabId = sender.tab?.id ?? null;
  if (!ownerTabId) {
    sendResponse({ ok: false, error: "Could not identify the MeetMind tab to report capture status." });
    return false;
  }

  void startCapture({
    ownerTabId,
    meetingId: message.meetingId,
    meetingUrl: message.meetingUrl,
    token: message.token,
    wsBase: message.wsBase,
    targetTabId: message.targetTabId ?? null
  })
    .then(() => sendResponse({ ok: true }))
    .catch(async (error) => {
      captureSession = null;
      const errMsg = error instanceof Error ? error.message : "Failed to start capture.";
      await chrome.tabs.sendMessage(ownerTabId, {
        source: EXT_SOURCE,
        type: "CAPTURE_ERROR",
        error: errMsg
      }).catch(() => null);
      sendResponse({ ok: false, error: errMsg });
    });

  return true;
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== EXT_SOURCE) return;

  if (message.type === "CAPTURE_STATUS" || message.type === "CAPTURE_ERROR" || message.type === "CAPTURE_STOPPED") {
    if (message.type === "CAPTURE_STOPPED" && message.sessionId && captureSession?.sessionId === message.sessionId) {
      captureSession = null;
      void closeOffscreenWhenIdle();
    }
    void forwardToOwner(message);
  }

  if (message.type === "OFFSCREEN_IDLE") {
    void closeOffscreenWhenIdle();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!captureSession) return;
  if (captureSession.meetingTabId === tabId) {
    void stopCapture("tab-closed", "The meeting tab was closed.");
  } else if (captureSession.ownerTabId === tabId) {
    void stopCapture("owner-tab-closed", "The MeetMind tab was closed.");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!captureSession) return;

  if (captureSession.ownerTabId === tabId && changeInfo.status === "loading") {
    captureSession.reconnectCount = (captureSession.reconnectCount || 0) + 1;
  }

  if (captureSession.meetingTabId !== tabId) return;

  if (changeInfo.url && !isMeetingUrl(changeInfo.url)) {
    void forwardToOwner({
      sessionId: captureSession.sessionId,
      type: "CAPTURE_STATUS",
      status: "transcribing",
      detail: `Meeting tab navigated to ${meetingHostLabel(changeInfo.url)}.`
    });
    void stopCapture("url-left-meeting", "The meeting tab left the call URL.");
    return;
  }

  if (tab.mutedInfo?.muted) {
    void forwardToOwner({
      sessionId: captureSession.sessionId,
      type: "CAPTURE_STATUS",
      status: "recording",
      detail: "Meeting tab is muted. Audio may be silent until unmuted."
    });
  }

  if (tab.discarded) {
    void stopCapture("tab-discarded", "The meeting tab was discarded by the browser.");
  }
});
