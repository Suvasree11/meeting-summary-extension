const PAGE_SOURCE = "meetmind-app";
const EXT_SOURCE = "meetmind-extension";

function postToPage(message) {
  window.postMessage({ source: EXT_SOURCE, ...message }, "*");
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE) return;

  if (data.type === "MEETMIND_PING") {
    postToPage({ type: "CAPTURE_READY" });
    return;
  }

  if (data.type === "MEETMIND_START_CAPTURE" || data.type === "MEETMIND_STOP_CAPTURE") {
    chrome.runtime.sendMessage(data);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== EXT_SOURCE) return;
  postToPage(message);
});

postToPage({ type: "CAPTURE_READY" });
