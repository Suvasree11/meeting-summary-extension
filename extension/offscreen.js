const EXT_SOURCE = "meetmind-extension";

const preferredMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4"
];

let session = null;
let mediaStream = null;
let recorder = null;
let socket = null;
let reconnectTimer = null;
let stopping = false;
let pendingBuffers = [];
let startSent = false;

function bestMimeType() {
  return preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function postStatus(status, detail = "") {
  chrome.runtime.sendMessage({
    source: EXT_SOURCE,
    type: "CAPTURE_STATUS",
    status,
    detail
  }).catch(() => null);
}

function postError(error) {
  chrome.runtime.sendMessage({
    source: EXT_SOURCE,
    type: "CAPTURE_ERROR",
    error
  }).catch(() => null);
}

function flushPending() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (pendingBuffers.length > 0) {
    socket.send(pendingBuffers.shift());
  }
}

function sendStart() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !session) return;
  socket.send(JSON.stringify({
    type: "audio_start",
    meetingId: session.meetingId,
    speaker: session.meetingTabTitle || "Meeting audio",
    language: navigator.language ? navigator.language.split("-")[0] : "en",
    mimeType: recorder?.mimeType || session.mimeType || "audio/webm",
    startMs: 0,
    endMs: 0
  }));
  startSent = true;
}

function connectSocket() {
  if (!session || stopping) return;
  socket = new WebSocket(`${session.wsBase}?meetingId=${encodeURIComponent(session.meetingId)}&token=${encodeURIComponent(session.token)}`);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    postStatus("recording", `Streaming from ${session.meetingTabTitle || "the selected meeting tab"}.`);
    sendStart();
    flushPending();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "audio_status" && message.status === "transcribing") {
      postStatus("transcribing", "Processing audio chunk.");
    }
    if (message.type === "audio_status" && message.status === "listening") {
      postStatus("recording", "Listening for the next audio chunk.");
    }
    if (message.type === "audio_status" && message.status === "no_speech") {
      postStatus("recording", "No speech detected in the last segment.");
    }
    if (message.type === "error") {
      postError(message.error);
    }
  };
  socket.onerror = () => {
    postStatus("error", "The transcript socket errored. Reconnecting.");
  };
  socket.onclose = () => {
    if (stopping) return;
    postStatus("transcribing", "Reconnecting to the transcript stream.");
    clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectSocket, 1000);
  };
}

async function startRecorder() {
  if (!mediaStream) return;
  const mimeType = bestMimeType();
  recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = async (event) => {
    if (event.data.size === 0) return;
    const buffer = await event.data.arrayBuffer();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(buffer);
      return;
    }
    pendingBuffers.push(buffer);
  };
  recorder.onstop = () => {
    if (!stopping && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio_stop", meetingId: session?.meetingId }));
    }
  };
  recorder.start(1200);
}

async function beginCapture(nextSession) {
  session = nextSession;
  stopping = false;
  startSent = false;
  postStatus("starting", "Opening meeting audio stream.");
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: session.streamId
      }
    },
    video: false
  });
  await startRecorder();
  connectSocket();
}

async function stopCapture() {
  stopping = true;
  clearTimeout(reconnectTimer);
  try {
    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }
  } catch {
    // Ignore recorder shutdown errors during teardown.
  }
  try {
    mediaStream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Ignore teardown errors.
  }
  try {
    if (socket && socket.readyState === WebSocket.OPEN && session?.meetingId) {
      socket.send(JSON.stringify({ type: "audio_stop", meetingId: session.meetingId }));
    }
    socket?.close();
  } catch {
    // Ignore teardown errors.
  }
  mediaStream = null;
  recorder = null;
  socket = null;
  pendingBuffers = [];
  startSent = false;
  postStatus("idle", "Capture stopped.");
  chrome.runtime.sendMessage({ source: EXT_SOURCE, type: "CAPTURE_STOPPED" }).catch(() => null);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== EXT_SOURCE) return;
  if (message.type === "START_CAPTURE") {
    beginCapture(message.session).catch((error) => {
      postError(error instanceof Error ? error.message : "Unable to start capture.");
    });
  }
  if (message.type === "STOP_CAPTURE") {
    void stopCapture();
  }
  if (message.type === "CAPTURE_STATUS" || message.type === "CAPTURE_ERROR" || message.type === "CAPTURE_STOPPED") {
    // No-op here; background forwards these to the app page.
  }
});
