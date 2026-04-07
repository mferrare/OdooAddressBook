'use strict';

const $ = (sel) => document.querySelector(sel);

let isSyncing = false;

async function init() {
  const settings = await messenger.runtime.sendMessage({ action: 'getSettings' });

  if (!settings || !settings.configured) {
    $('#not-configured').classList.remove('hidden');
    $('#main-panel').classList.add('hidden');
    $('#setup-btn').addEventListener('click', () => {
      messenger.runtime.sendMessage({ action: 'openOptions' });
      window.close();
    });
    return;
  }

  $('#not-configured').classList.add('hidden');
  $('#main-panel').classList.remove('hidden');

  // Load current status
  await refreshStatus();

  // Listen for background status changes / progress
  messenger.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'statusChanged') {
      applyStatus(msg.status, msg.result);
    }
    if (msg.action === 'syncProgress') {
      $('#progress-row').classList.remove('hidden');
      $('#progress-msg').textContent = msg.message;
    }
  });

  $('#sync-btn').addEventListener('click', async () => {
    if (isSyncing) return;
    startSyncing();
    const res = await messenger.runtime.sendMessage({ action: 'sync' });
    if (!res.success) {
      applyStatus('error', { error: res.error });
    }
    // Status update will come via 'statusChanged' message
  });

  $('#settings-btn').addEventListener('click', () => {
    messenger.runtime.sendMessage({ action: 'openOptions' });
    window.close();
  });
}

async function refreshStatus() {
  const data = await messenger.runtime.sendMessage({ action: 'getStatus' });
  applyStatus(data.status, data.lastResult);
  if (data.lastSyncTime) {
    $('#last-sync-time').textContent = formatTime(data.lastSyncTime);
  }
}

function applyStatus(status, result) {
  const dot  = $('#status-dot');
  const text = $('#status-text');
  const err  = $('#error-box');
  const progressRow = $('#progress-row');

  dot.className = `dot ${status}`;

  switch (status) {
    case 'syncing':
      text.textContent = 'Syncing…';
      isSyncing = true;
      $('#sync-btn').disabled = true;
      break;

    case 'error':
      text.textContent = 'Error';
      isSyncing = false;
      $('#sync-btn').disabled = false;
      progressRow.classList.add('hidden');
      if (result?.error) {
        err.textContent = result.error;
        err.classList.remove('hidden');
      }
      break;

    case 'idle':
    default:
      text.textContent = 'Idle';
      isSyncing = false;
      $('#sync-btn').disabled = false;
      err.classList.add('hidden');
      progressRow.classList.add('hidden');

      if (result && result.created !== undefined) {
        const { created = 0, updated = 0, errors = [] } = result;
        let summary = `+${created} created, ${updated} updated`;
        if (errors.length > 0) summary += `, ${errors.length} error(s)`;
        $('#last-result-text').textContent = summary;
        $('#last-result-row').classList.remove('hidden');

        // Update last sync time display
        $('#last-sync-time').textContent = formatTime(new Date().toISOString());
      }
      break;
  }
}

function startSyncing() {
  isSyncing = true;
  $('#sync-btn').disabled = true;
  $('#status-dot').className = 'dot syncing';
  $('#status-text').textContent = 'Syncing…';
  $('#error-box').classList.add('hidden');
  $('#progress-row').classList.remove('hidden');
  $('#progress-msg').textContent = 'Starting…';
}

function formatTime(iso) {
  if (!iso) return 'Never';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs  = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1)   return 'Just now';
    if (diffMin < 60)  return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr  < 24)  return `${diffHr}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

document.addEventListener('DOMContentLoaded', init);
