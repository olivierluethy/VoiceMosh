// VoiceMosh — background service worker (MV3)
// Forwards keyboard-shortcut commands to the active tab and ensures the
// content script is alive before the popup tries to talk to it.

const CONTENT_SCRIPT_FILE = 'content.js';

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await ensureContentScript(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'voicemosh:toggle-panel' });
  } catch (err) {
    // Tab may not be a regular web page (chrome://, file://, etc.) — silently ignore.
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'voicemosh:ensure-content') {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'no-tab' });
      return true;
    }
    ensureContentScript(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true; // async response
  }
  return false;
});

async function ensureContentScript(tabId) {
  // Ping first; only inject if no listener is registered.
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'voicemosh:ping' });
    if (res?.ok) return;
  } catch (_) {
    // No content script yet — fall through to injection.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE],
  });
}
