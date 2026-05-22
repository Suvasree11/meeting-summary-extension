const MEETING_SOURCE = "meetmind-meeting";

let lastSignature = "";

function visibleText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function detectPlatform() {
  const host = location.hostname;
  if (host.includes("meet.google")) return "google-meet";
  if (host.includes("zoom.us")) return "zoom";
  if (host.includes("teams.microsoft") || host.includes("teams.live")) return "microsoft-teams";
  if (host.includes("loom.com")) return "loom";
  return "unknown";
}

function isMutedNode(node) {
  const label = visibleText(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || "");
  return /\b(muted|microphone off|mic off|audio off)\b/i.test(label);
}

function isPresentingNode(node) {
  const label = visibleText(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || node.textContent);
  return /\b(presenting|presentation|screen share|you are presenting|is presenting)\b/i.test(label);
}

function isSpeakingNode(node) {
  if (node.matches?.("[data-is-speaking='true'], [data-speaking='true'], [data-active-speaker='true']")) return true;
  const label = visibleText(node.getAttribute?.("aria-label") || "");
  if (/\b(speaking|is talking|talking now)\b/i.test(label)) return true;
  return Boolean(
    node.querySelector?.("[data-is-speaking='true'], [data-speaking='true'], [data-active-speaker='true'], .IisKdb, .gjg47b")
  );
}

function cleanParticipantName(raw) {
  return visibleText(raw)
    .replace(/\b(mute|unmute|muted|camera|video|participant|person|more actions|pin|remove|host|co-host|you|your)\b/gi, "")
    .replace(/[(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushParticipant(map, participant) {
  const name = cleanParticipantName(participant.name);
  if (!name || name.length < 2 || name.length > 80) return;
  if (/\b(joined|left|waiting|meeting|unknown)\b/i.test(name)) return;
  const key = participant.platformId || name.toLowerCase();
  const existing = map.get(key);
  if (!existing) {
    map.set(key, participant);
    return;
  }
  existing.muted = existing.muted || participant.muted;
  existing.isPresenting = existing.isPresenting || participant.isPresenting;
  existing.isSpeaking = existing.isSpeaking || participant.isSpeaking;
  existing.status = participant.status || existing.status;
}

function extractGoogleMeet() {
  const map = new Map();
  document.querySelectorAll("[data-participant-id], [data-requested-participant-id]").forEach((node) => {
    const platformId =
      node.getAttribute("data-participant-id") || node.getAttribute("data-requested-participant-id") || undefined;
    const selfName = node.querySelector?.("[data-self-name]")?.getAttribute("data-self-name");
    const aria = node.getAttribute("aria-label");
    const name = selfName || aria || node.textContent;
    pushParticipant(map, {
      platformId,
      name,
      label: cleanParticipantName(name),
      status: "active",
      muted: isMutedNode(node),
      isPresenting: isPresentingNode(node),
      isSpeaking: isSpeakingNode(node),
      source: "extension"
    });
  });
  return [...map.values()];
}

function extractZoom() {
  const map = new Map();
  document
    .querySelectorAll(
      "[class*='participant'], [id^='participant'], [aria-label*='participant' i], [data-participant-id]"
    )
    .forEach((node) => {
      const platformId = node.getAttribute("data-participant-id") || node.id || undefined;
      const aria = node.getAttribute("aria-label") || "";
      const name = aria.split(",")[0] || node.textContent;
      pushParticipant(map, {
        platformId,
        name,
        label: cleanParticipantName(name),
        status: "active",
        muted: isMutedNode(node),
        isPresenting: isPresentingNode(node),
        isSpeaking: isSpeakingNode(node),
        source: "extension"
      });
    });
  return [...map.values()];
}

function extractTeams() {
  const map = new Map();
  document.querySelectorAll("[data-tid], [role='menuitem'], [aria-label]").forEach((node) => {
    const aria = node.getAttribute("aria-label") || "";
    if (!/\b(mute|camera|pin|raise|react|people|participant)\b/i.test(aria)) return;
    const name = aria.replace(/\b(mute|unmute|muted|camera|pin|raise hand|react|more options)\b/gi, "").trim();
    const platformId = node.getAttribute("data-tid") || undefined;
    pushParticipant(map, {
      platformId,
      name,
      label: cleanParticipantName(name),
      status: "active",
      muted: isMutedNode(node),
      isPresenting: isPresentingNode(node),
      isSpeaking: isSpeakingNode(node),
      source: "extension"
    });
  });
  return [...map.values()];
}

function extractLoom() {
  const map = new Map();
  document.querySelectorAll("[class*='participant'], [data-testid*='participant'], [aria-label]").forEach((node) => {
    const aria = node.getAttribute("aria-label") || "";
    if (!aria || aria.length > 100) return;
    pushParticipant(map, {
      platformId: aria.toLowerCase().replace(/\s+/g, "-"),
      name: aria,
      label: cleanParticipantName(aria),
      status: "active",
      muted: isMutedNode(node),
      isPresenting: isPresentingNode(node),
      isSpeaking: isSpeakingNode(node),
      source: "extension"
    });
  });
  return [...map.values()];
}

function extractGeneric() {
  const map = new Map();
  document
    .querySelectorAll("[data-self-name], [aria-label*='participant' i], [aria-label*='person' i]")
    .forEach((node) => {
      const name = node.getAttribute("data-self-name") || node.getAttribute("aria-label") || node.textContent;
      pushParticipant(map, {
        platformId: node.getAttribute("data-participant-id") || undefined,
        name,
        label: cleanParticipantName(name),
        status: "active",
        muted: isMutedNode(node),
        isPresenting: isPresentingNode(node),
        isSpeaking: isSpeakingNode(node),
        source: "extension"
      });
    });
  return [...map.values()];
}

function collectParticipants() {
  const platform = detectPlatform();
  const extractors = {
    "google-meet": extractGoogleMeet,
    zoom: extractZoom,
    "microsoft-teams": extractTeams,
    loom: extractLoom
  };
  const extractor = extractors[platform] ?? extractGeneric;
  const participants = extractor();
  if (participants.length > 0) return participants.slice(0, 40);
  return extractGeneric().slice(0, 40);
}

function publishParticipants() {
  const participants = collectParticipants();
  const signature = participants
    .map((participant) =>
      [
        participant.platformId || "",
        participant.name,
        participant.muted ? "m" : "",
        participant.isPresenting ? "p" : "",
        participant.isSpeaking ? "s" : ""
      ].join(":")
    )
    .join("|");
  if (!participants.length || signature === lastSignature) return;
  lastSignature = signature;
  chrome.runtime
    .sendMessage({
      source: MEETING_SOURCE,
      type: "PARTICIPANTS",
      platform: detectPlatform(),
      participants
    })
    .catch(() => null);
}

const observer = new MutationObserver(() => publishParticipants());
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["aria-label", "data-self-name", "data-participant-id", "data-tid", "data-is-speaking", "class"]
});
window.addEventListener("beforeunload", () => {
  chrome.runtime.sendMessage({ source: MEETING_SOURCE, type: "MEETING_UNLOAD" }).catch(() => null);
});
window.setInterval(publishParticipants, 4000);
publishParticipants();
