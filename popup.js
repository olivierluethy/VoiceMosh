// VoiceMosh — popup controller
// Bridges the popup form to the active tab's content script.

const $form = document.getElementById('vm-form');
const $input = document.getElementById('vm-query');
const $status = document.getElementById('vm-status');
const $controls = document.getElementById('vm-controls');
const $counter = document.getElementById('vm-counter');
const $prev = document.getElementById('vm-prev');
const $next = document.getElementById('vm-next');
const $clear = document.getElementById('vm-clear');

let lastCount = 0;

document.addEventListener('DOMContentLoaded', () => {
  // Restore the previous query so retries are quick.
  chrome.storage?.local.get(['lastQuery'], ({ lastQuery }) => {
    if (lastQuery) {
      $input.value = lastQuery;
      $input.select();
    }
    $input.focus();
  });
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text, kind = '') {
  $status.textContent = text;
  $status.className = 'vm-status' + (kind ? ' ' + kind : '');
}

function setControls(count, activeIndex = 0) {
  lastCount = count;
  if (count > 1) {
    $controls.hidden = false;
    $counter.textContent = `${activeIndex + 1} of ${count}`;
  } else {
    $controls.hidden = true;
  }
}

async function send(message) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab.');
  if (tab.url && /^(chrome|edge|brave|about|chrome-extension):/.test(tab.url)) {
    throw new Error('VoiceMosh can\'t run on this page.');
  }
  // Make sure the content script is injected before sending.
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'voicemosh:ensure-content', tabId: tab.id }, () => resolve());
  });
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(response);
    });
  });
}

async function runSearch(query) {
  const q = (query || '').trim();
  if (!q) {
    setStatus('Type a description and press Enter.');
    setControls(0);
    return;
  }
  setStatus('Searching…');
  try {
    chrome.storage?.local.set({ lastQuery: q });
    const res = await send({ type: 'voicemosh:search', query: q });
    if (!res?.ok) {
      setStatus(res?.error || 'Search failed.', 'error');
      setControls(0);
      return;
    }
    if (res.count === 0) {
      setStatus('No matches found — try different wording.', 'error');
      setControls(0);
      return;
    }
    if (res.count === 1) {
      setStatus('Found 1 match', 'success');
    } else {
      setStatus(`Found ${res.count} possible matches`, 'success');
    }
    setControls(res.count, res.activeIndex || 0);
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', 'error');
    setControls(0);
  }
}

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch($input.value);
});

$input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && lastCount > 1) {
    e.preventDefault();
    cycle('next');
  } else if (e.key === 'ArrowUp' && lastCount > 1) {
    e.preventDefault();
    cycle('prev');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    runClear();
  }
});

async function cycle(direction) {
  try {
    const res = await send({ type: direction === 'next' ? 'voicemosh:next' : 'voicemosh:prev' });
    if (res?.ok && res.count) {
      setControls(res.count, res.activeIndex || 0);
    }
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', 'error');
  }
}

$prev.addEventListener('click', () => cycle('prev'));
$next.addEventListener('click', () => cycle('next'));

async function runClear() {
  try {
    await send({ type: 'voicemosh:clear' });
    setStatus('Highlights cleared.');
    setControls(0);
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', 'error');
  }
}

$clear.addEventListener('click', runClear);
