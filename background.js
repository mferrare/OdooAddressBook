/**
 * Background script — entry point for the extension.
 *
 * Responsibilities:
 *   - Open the options page on first install.
 *   - Set up / restore the periodic sync alarm.
 *   - Run sync on each alarm tick.
 *   - Handle messages from the popup and options page.
 */

const SYNC_ALARM = 'odoo-periodic-sync';
const DEFAULT_INTERVAL_MINUTES = 30;

// ── Install hook ──────────────────────────────────────────────────────────────

messenger.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await messenger.tabs.create({ url: 'options/options.html' });
  }
});

// ── Alarm handler ─────────────────────────────────────────────────────────────

messenger.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) {
    await runSync();
  }
});

// ── Message bus (popup ↔ options ↔ background) ───────────────────────────────

messenger.runtime.onMessage.addListener((message, _sender) => {
  switch (message.action) {
    case 'sync':
      return runSync();

    case 'getStatus':
      return getStatus();

    case 'getAddressBooks':
      return listAddressBooks();

    case 'getDatabases':
      return getDatabases(message.url);

    case 'testConnection':
      return testConnection(message.settings);

    case 'saveSettings':
      return saveSettings(message.settings);

    case 'getSettings':
      return loadSettings();

    case 'openOptions':
      messenger.tabs.create({ url: 'options/options.html' });
      return Promise.resolve();

    case 'resetSync':
      return resetSyncState();

    default:
      return Promise.resolve({ error: 'Unknown action' });
  }
});

// ── Core functions ────────────────────────────────────────────────────────────

async function runSync() {
  const settings = await loadSettings();
  if (!settings?.configured) {
    return { success: false, error: 'Extension not configured yet.' };
  }

  await setStatus('syncing');

  try {
    const result = await SyncEngine.sync(settings, (msg) => {
      // Broadcast progress to any open popup
      messenger.runtime.sendMessage({ action: 'syncProgress', message: msg }).catch(() => {});
    });

    await setStatus('idle', result);
    await showSyncNotification(result);
    return { success: true, result };
  } catch (err) {
    const error = err.message || String(err);
    await setStatus('error', { error });
    return { success: false, error };
  }
}

async function loadSettings() {
  const data = await messenger.storage.local.get('settings');
  return data.settings || null;
}

async function saveSettings(settings) {
  await messenger.storage.local.set({ settings: { ...settings, configured: true } });
  await setupAlarm(settings.syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES);
  return { success: true };
}

async function listAddressBooks() {
  try {
    const all = await messenger.addressBooks.list();
    const writable = all.filter(b => b.type === 'addressBook' && !b.readOnly);
    return { success: true, books: writable };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getDatabases(url) {
  if (!url) return { success: false, error: 'No URL provided.' };
  const api = new OdooAPI(url);
  return api.getDatabases();
}

async function testConnection(settings) {
  if (!settings?.odooUrl || !settings?.odooDb) {
    return { success: false, error: 'URL and database are required.' };
  }
  const api = new OdooAPI(settings.odooUrl);
  return api.authenticate(settings.odooDb, settings.odooUsername, settings.odooPassword, settings.odooApiKey || '');
}

async function resetSyncState() {
  await SyncEngine.saveSyncState({ pairs: {} });
  return { success: true };
}

// ── Status helpers ────────────────────────────────────────────────────────────

async function getStatus() {
  const data = await messenger.storage.local.get(['syncStatus', 'lastSyncResult', 'lastSyncTime']);
  return {
    status:      data.syncStatus    || 'idle',
    lastResult:  data.lastSyncResult || null,
    lastSyncTime: data.lastSyncTime  || null
  };
}

async function setStatus(status, result = null) {
  const update = { syncStatus: status };
  if (result !== null) update.lastSyncResult = result;
  if (status === 'idle' || status === 'error') {
    update.lastSyncTime = new Date().toISOString();
  }
  await messenger.storage.local.set(update);
  // Notify popup if open
  messenger.runtime.sendMessage({ action: 'statusChanged', status, result }).catch(() => {});
}

// ── Alarm management ─────────────────────────────────────────────────────────

async function setupAlarm(intervalMinutes) {
  await messenger.alarms.clear(SYNC_ALARM);
  messenger.alarms.create(SYNC_ALARM, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes
  });
}

// ── Notification ─────────────────────────────────────────────────────────────

async function showSyncNotification(result) {
  const settings = await loadSettings();
  if (!settings?.showNotifications) return;

  const { created = 0, updated = 0, errors = [] } = result;
  let msg = `Created: ${created}, Updated: ${updated}`;
  if (errors.length > 0) msg += `, Errors: ${errors.length}`;

  messenger.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon.svg',
    title: 'Odoo Sync Complete',
    message: msg
  });
}

// ── Bootstrap on browser start ───────────────────────────────────────────────

(async () => {
  const settings = await loadSettings();
  if (settings?.configured) {
    await setupAlarm(settings.syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES);
  }
})();
