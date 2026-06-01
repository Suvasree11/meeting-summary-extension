const EXT_SOURCE = "meetmind-extension";

const preferredMimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 750;
const RECONNECT_MAX_MS = 30000;

let activeCapture = null;
let startInFlight = null;

function bestMimeType() {
  return preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function postStatus(capture, status, detail = "") {
  chrome.runtime
    .sendMessage({
      source: EXT_SOURCE,
      type: "CAPTURE_STATUS",
      sessionId: capture.session.sessionId,
      status,
      detail
    })
    .catch(() => null);
}

function postError(capture, error) {
  chrome.runtime
    .sendMessage({
      source: EXT_SOURCE,
      type: "CAPTURE_ERROR",
      sessionId: capture.session.sessionId,
      error
    })
    .catch(() => null);
}

function flushPending(capture) {
  if (!capture.socket || capture.socket.readyState !== WebSocket.OPEN) return;
  while (capture.pendingBuffers.length > 0) {
    capture.socket.send(capture.pendingBuffers.shift());
  }
}

function sendStart(capture) {
  if (!capture.socket || capture.socket.readyState !== WebSocket.OPEN || capture.startSent) return;
  capture.socket.send(
    JSON.stringify({
      type: "audio_start",
      meetingId: capture.session.meetingId,
      speaker: capture.session.meetingTabTitle || "Meeting audio",
      language: navigator.language ? navigator.language.split("-")[0] : "en",
      mimeType: capture.recorder?.mimeType || capture.session.mimeType || "audio/webm",
      startMs: 0,
      endMs: 0
    })
  );
  capture.startSent = true;
}

function sendMeetingEnd(capture, reason) {
  if (!capture.socket || capture.socket.readyState !== WebSocket.OPEN) return;
  capture.socket.send(
    JSON.stringify({
      type: "meeting_end",
      meetingId: capture.session.meetingId,
      reason,
      endedBy: "extension",
      metadata: {
        meetingTabId: capture.session.meetingTabId,
        meetingTabUrl: capture.session.meetingTabUrl,
        meetingTabTitle: capture.session.meetingTabTitle,
        reconnectCount: capture.session.reconnectCount || 0
      }
    })
  );
}

function clearReconnectTimer(capture) {
  if (capture.reconnectTimer != null) {
    clearTimeout(capture.reconnectTimer);
    capture.reconnectTimer = null;
  }
}

function scheduleReconnect(capture) {
  if (capture.stopping || capture.reconnectTimer != null) return;
  if (capture.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    postError(capture, "Lost connection to the transcript server. Stop and restart capture.");
    void stopCapture(capture.session.sessionId, "reconnect-exhausted");
    return;
  }

  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** capture.reconnectAttempts);
  capture.reconnectAttempts += 1;
  capture.session.reconnectCount = (capture.session.reconnectCount || 0) + 1;

  postStatus(capture, "reconnecting", `Reconnecting in ${Math.round(delay / 1000)}s…`);

  capture.reconnectTimer = window.setTimeout(() => {
    capture.reconnectTimer = null;
    if (capture.stopping) return;
    connectSocket(capture);
  }, delay);
}

function teardownSocket(capture) {
  clearReconnectTimer(capture);
  const socket = capture.socket;
  capture.socket = null;
  if (!socket) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  } catch {
    // Ignore close races.
  }
}

function teardownRecorder(capture) {
  const recorder = capture.recorder;
  capture.recorder = null;
  if (!recorder) return;
  recorder.ondataavailable = null;
  recorder.onstop = null;
  try {
    if (recorder.state === "recording") recorder.stop();
  } catch {
    // Ignore recorder shutdown errors.
  }
}

function teardownAudio(capture) {
  try {
    capture.sourceNode?.disconnect();
  } catch {
    // Ignore graph teardown errors.
  }
  capture.sourceNode = null;
  capture.recordDest = null;
  const ctx = capture.audioContext;
  capture.audioContext = null;
  capture.recordStream = null;
  if (ctx) {
    void ctx.close().catch(() => null);
  }
}

function teardownStream(capture) {
  teardownAudio(capture);
  try {
    capture.mediaStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    capture.micStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
  } catch {
    // Ignore teardown errors.
  }
  capture.mediaStream = null;
  capture.micStream = null;
}

/** Route tab audio to speakers and a forked stream for MediaRecorder. */
async function setupAudioRouting(capture) {
  const audioContext = new AudioContext();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const recordDest = audioContext.createMediaStreamDestination();

  if (capture.mediaStream && capture.mediaStream.getAudioTracks().length > 0) {
    const tabSource = audioContext.createMediaStreamSource(capture.mediaStream);
    tabSource.connect(audioContext.destination);
    tabSource.connect(recordDest);
  }

  if (capture.micStream && capture.micStream.getAudioTracks().length > 0) {
    const micTrack = capture.micStream.getAudioTracks()[0];
    const micSource = audioContext.createMediaStreamSource(capture.micStream);
    const micGain = audioContext.createGain();
    micGain.gain.value = 1.5; // Boost mic level so it's not drowned out by tab audio
    micSource.connect(micGain);
    micGain.connect(recordDest); // Do not connect to destination to avoid echo
  }

  capture.audioContext = audioContext;
  capture.recordDest = recordDest;
  capture.recordStream = recordDest.stream;

  // #region agent log
  const mixedTrack = recordDest.stream.getAudioTracks()[0];
  fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
    body: JSON.stringify({
      sessionId: "b5045b",
      hypothesisId: "H",
      location: "offscreen.js:setupAudioRouting",
      message: "audio routing ready",
      data: {
        contextState: audioContext.state,
        hasMicStream: Boolean(capture.micStream),
        hasMicTrack: Boolean(capture.micStream?.getAudioTracks().length),
        hasMixedTrack: Boolean(mixedTrack),
        mixedTrackEnabled: mixedTrack?.enabled,
        mixedTrackMuted: mixedTrack?.muted,
        mixedTrackReadyState: mixedTrack?.readyState
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

function connectSocket(capture) {
  if (capture.stopping) return;

  teardownSocket(capture);
  capture.startSent = false;

  const socket = new WebSocket(
    `${capture.session.wsBase}?meetingId=${encodeURIComponent(capture.session.meetingId)}&token=${encodeURIComponent(capture.session.token)}`
  );
  capture.socket = socket;
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    if (capture.stopping || capture.socket !== socket) return;
    capture.reconnectAttempts = 0;
    postStatus(capture, "recording", `Streaming from ${capture.session.meetingTabTitle || "the selected tab"}.`);
    sendStart(capture);
    flushPending(capture);
  };

  socket.onmessage = (event) => {
    if (capture.stopping || capture.socket !== socket) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "audio_status" && message.status === "transcribing") {
        postStatus(capture, "transcribing", "Processing audio chunk.");
      }
      if (message.type === "audio_status" && message.status === "listening") {
        postStatus(capture, "recording", "Listening for the next audio chunk.");
      }
      if (message.type === "audio_status" && message.status === "no_speech") {
        postStatus(capture, "recording", "No speech detected in the last segment.");
      }
      if (message.type === "meeting-ended") {
        postStatus(capture, "ended", "Meeting ended. Final notes are ready.");
      }
      if (message.type === "error") {
        postError(capture, message.error);
      }
    } catch {
      // Ignore malformed server messages.
    }
  };

  socket.onerror = () => {
    if (capture.stopping || capture.socket !== socket) return;
    postStatus(capture, "reconnecting", "Transcript connection error. Retrying.");
  };

  socket.onclose = () => {
    if (capture.stopping || capture.socket !== socket) return;
    capture.socket = null;
    scheduleReconnect(capture);
  };
}

async function startRecorder(capture) {
  const mimeType = bestMimeType();
  const recordStream = capture.recordStream ?? capture.mediaStream;
  const recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined);
  capture.recorder = recorder;

  recorder.ondataavailable = async (event) => {
    if (capture.stopping || event.data.size === 0) return;
    // #region agent log
    if (!capture._loggedChunk) {
      capture._loggedChunk = true;
      fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
        body: JSON.stringify({
          sessionId: "b5045b",
          hypothesisId: "I",
          location: "offscreen.js:ondataavailable",
          message: "first audio chunk",
          data: { chunkBytes: event.data.size },
          timestamp: Date.now()
        })
      }).catch(() => {});
    }
    // #endregion
    const buffer = await event.data.arrayBuffer();
    if (capture.socket?.readyState === WebSocket.OPEN) {
      capture.socket.send(buffer);
      return;
    }
    if (capture.pendingBuffers.length < 48) {
      capture.pendingBuffers.push(buffer);
    }
  };

  recorder.onstop = () => {
    if (capture.stopping) return;
    if (capture.socket?.readyState === WebSocket.OPEN) {
      capture.socket.send(JSON.stringify({ type: "audio_stop", meetingId: capture.session.meetingId }));
    }
  };

  recorder.start(250);
}

async function beginCapture(nextSession) {
  if (startInFlight) {
    await startInFlight.catch(() => null);
  }

  startInFlight = (async () => {
    if (activeCapture) {
      await stopCapture(activeCapture.session.sessionId, "superseded");
    }

    const capture = {
      session: nextSession,
      mediaStream: null,
      micStream: null,
      audioContext: null,
      recordDest: null,
      recordStream: null,
      recorder: null,
      socket: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      stopping: false,
      pendingBuffers: [],
      startSent: false
    };
    activeCapture = capture;

    // #region agent log
    fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
      body: JSON.stringify({
        sessionId: "b5045b",
        hypothesisId: "D",
        location: "offscreen.js:beginCapture",
        message: "beginCapture started",
        data: { sessionId: nextSession.sessionId },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion

    postStatus(capture, "starting", "Opening tab audio stream.");

    capture.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: nextSession.streamId
        }
      },
      video: false
    });

    try {
      capture.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("Unable to capture microphone:", err);
    }

    if (capture.stopping || activeCapture !== capture) {
      teardownStream(capture);
      return;
    }

    capture.mediaStream.getTracks().forEach((track) => {
      track.onended = () => {
        if (!capture.stopping) void stopCapture(capture.session.sessionId, "stream-ended");
      };
    });

    await setupAudioRouting(capture);
    if (capture.stopping || activeCapture !== capture) {
      teardownStream(capture);
      return;
    }

    await startRecorder(capture);
    connectSocket(capture);
  })();

  try {
    await startInFlight;
  } catch (error) {
    if (activeCapture) {
      postError(activeCapture, error instanceof Error ? error.message : "Unable to start capture.");
      await stopCapture(activeCapture.session.sessionId, "start-error");
    }
    throw error;
  } finally {
    startInFlight = null;
  }
}

async function stopCapture(sessionId, reason = "manual-stop") {
  const capture = activeCapture?.session.sessionId === sessionId ? activeCapture : null;
  if (!capture || capture.stopping) return;

  capture.stopping = true;
  activeCapture = null;
  capture.pendingBuffers.length = 0;

  // #region agent log
  fetch("http://127.0.0.1:7474/ingest/be4f0a31-b5ef-428e-b24c-afb9421f2bef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b5045b" },
    body: JSON.stringify({
      sessionId: "b5045b",
      hypothesisId: "C",
      location: "offscreen.js:stopCapture",
      message: "stopCapture teardown",
      data: { sessionId, reason, hadSocket: Boolean(capture.socket), hadRecorder: Boolean(capture.recorder) },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  teardownRecorder(capture);

  if (capture.socket?.readyState === WebSocket.OPEN) {
    try {
      capture.socket.send(JSON.stringify({ type: "audio_stop", meetingId: capture.session.meetingId }));
      sendMeetingEnd(capture, reason);
    } catch {
      // Ignore send errors during shutdown.
    }
  }

  teardownSocket(capture);
  teardownStream(capture);

  const finalStatus = reason === "manual-stop" ? "ended" : "idle";
  const finalDetail = reason === "manual-stop" ? "Capture ended." : "Capture stopped.";
  postStatus(capture, finalStatus, finalDetail);

  chrome.runtime
    .sendMessage({ source: EXT_SOURCE, type: "CAPTURE_STOPPED", sessionId, reason })
    .catch(() => null);

  chrome.runtime.sendMessage({ source: EXT_SOURCE, type: "OFFSCREEN_IDLE" }).catch(() => null);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== EXT_SOURCE) return;

  if (message.type === "START_CAPTURE") {
    void beginCapture(message.session);
    return;
  }

  if (message.type === "STOP_CAPTURE") {
    void stopCapture(message.sessionId, message.reason ?? "manual-stop");
    return;
  }

  if (message.type === "PARTICIPANT_UPDATE") {
    const capture = activeCapture;
    if (!capture?.socket || capture.socket.readyState !== WebSocket.OPEN || capture.stopping) return;
    capture.socket.send(
      JSON.stringify({
        type: "participant_update",
        meetingId: capture.session.meetingId,
        participants: message.participants
      })
    );
  }
});
