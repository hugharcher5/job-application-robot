import { testConnection } from "./claude.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "testConnection") {
    testConnection()
      .then((text) => reply({ ok: true, text }))
      .catch((err) => reply({ ok: false, error: String(err.message || err) }));
    return true; // keep the channel open for the async reply
  }
});
