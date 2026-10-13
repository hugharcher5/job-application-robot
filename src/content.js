import { detectAts } from "./ats.js";
import { extractFields } from "./fields.js";

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "scan") {
    const fields = extractFields();
    // Frames with no form fields stay quiet so the top frame's answer wins.
    if (fields.length || window === window.top) {
      reply({ ats: detectAts(), url: location.href, fields });
    }
  }
});
