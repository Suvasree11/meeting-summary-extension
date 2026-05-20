const EXT_SOURCE = "meetmind-extension";

let activeSession = null;
let offscreenReady = false;

function isMeetingUrl(url) {
  if (!url) return false;
  return /meet\.google\.com|(?:^|\/)zoom\.us\/(j|my)\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/l\/meetup-join/i.test(url);
}

async function forwardToOwner(message) {
  if (!activeSession?.ownerTabId) return;
  try {
    await chrome.tabs.sendMessage(activeSession.ownerTabId, { source: EXT_SOURCE, ...message });
  } catch {
    // The app page may have been reloaded or closed. Keep capture running if possible.
  }
}

async function ensureOffscreen() {
  if (offscreenReady) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture meeting tab audio and stream live transcripts to MeetMind."
  });
  offscreenReady = true;
}

async function findMeetingTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.active && isMeetingUrl(tab.url)) ?? tabs.find((tab) => isMeetingUrl(tab.url)) ?? null;
}

async function stopCapture(detail = "Capture stopped.") {
  if (!activeSession) return;
  try {
    await chrome.runtime.sendMessage({ source: EXT_SOURCE, type: "STOP_CAPTURE" });
  } catch {
    // Ignore if offscreen is already gone.
  }
  await forwardToOwner({ type: "CAPTURE_STATUS", status: "stopping", detail });
  await forwardToOwner({ type: "CAPTURE_STOPPED" });
  activeSession = null;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.source !== "meetmind-app") return;

  if (message.type === "MEETMIND_STOP_CAPTURE") {
    void stopCapture();
    return;
  }

  if (message.type !== "MEETMIND_START_CAPTURE") return;

  const ownerTabId = sender.tab?.id ?? activeSession?.ownerTabId ?? null;
  if (!ownerTabId) {
    void chrome.runtime.sendMessage({
      source: EXT_SOURCE,
      type: "CAPTURE_ERROR",
      error: "Could not identify the MeetMind tab to report capture status."
    });
    return;
  }

  void (async () => {
    const meetingTab = await findMeetingTab();
    if (!meetingTab?.id) {
      await chrome.tabs.sendMessage(ownerTabId, {
        source: EXT_SOURCE,
        type: "CAPTURE_ERROR",
        error: "No Google Meet, Zoom, or Teams tab was found. Open the meeting tab and try again."
      }).catch(() => null);
      return;
    }

    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: meetingTab.id });

    activeSession = {
      ownerTabId,
      meetingTabId: meetingTab.id,
      meetingTabUrl: meetingTab.url ?? "",
      meetingTabTitle: meetingTab.title ?? "",
      meetingId: message.meetingId,
      token: message.token,
      wsBase: message.wsBase,
      streamId
    };

    await chrome.runtime.sendMessage({
      source: EXT_SOURCE,
      type: "START_CAPTURE",
      session: activeSession
    });

    await forwardToOwner({
      type: "CAPTURE_STATUS",
      status: "starting",
      detail: `Capturing ${meetingTab.title ?? "meeting tab"}`
    });
  })().catch(async (error) => {
    await chrome.tabs.sendMessage(ownerTabId, {
      source: EXT_SOURCE,
      type: "CAPTURE_ERROR",
      error: error instanceof Error ? error.message : "Failed to start capture."
    }).catch(() => null);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeSession?.meetingTabId !== tabId) return;
  void stopCapture("The meeting tab was closed.");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!activeSession || activeSession.meetingTabId !== tabId) return;
  if (changeInfo.url && !isMeetingUrl(changeInfo.url)) {
    void forwardToOwner({
      type: "CAPTURE_STATUS",
      status: "transcribing",
      detail: `Meeting tab moved to ${new URL(changeInfo.url).hostname}.`
    });
  }
  if (tab.discarded) {
    void forwardToOwner({
      type: "CAPTURE_STATUS",
      status: "transcribing",
      detail: "The meeting tab was discarded by the browser."
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== EXT_SOURCE) return;
  if (message.type === "CAPTURE_STATUS" || message.type === "CAPTURE_ERROR" || message.type === "CAPTURE_STOPPED") {
    void forwardToOwner(message);
  }
});
