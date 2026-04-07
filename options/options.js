'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const wizard = {
  currentStep: 1,
  settings: {
    addressBookId: '',
    addressBookName: '',
    odooUrl: '',
    odooDb: '',
    odooUsername: '',
    odooPassword: '',
    syncFilter: 'individuals_with_email',
    syncIntervalMinutes: 30,
    conflictResolution: 'odoo',
    showNotifications: true,
    configured: false
  }
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function showStep(n) {
  $$('.step').forEach(el => el.classList.add('hidden'));
  $(`#step-${n}`).classList.remove('hidden');
  $$('.step-dot').forEach(dot => {
    const s = Number(dot.dataset.step);
    dot.classList.toggle('active', s === n);
    dot.classList.toggle('done',   s <  n);
  });
  wizard.currentStep = n;
}

function setStatus(el, type, message) {
  el.className = `status-bar ${type}`;
  el.textContent = message;
}

function hideStatus(el) {
  el.className = 'status-bar hidden';
}

// ── Step 1: Address book ──────────────────────────────────────────────────────

async function initStep1() {
  const abSelect   = $('#ab-select');
  const abError    = $('#ab-error');
  const choiceNew  = () => $('input[name="abChoice"]:checked').value === 'new';

  // Load address books
  const res = await messenger.runtime.sendMessage({ action: 'getAddressBooks' });
  if (res.success && res.books.length > 0) {
    abSelect.innerHTML = res.books
      .map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`)
      .join('');
    abError.classList.add('hidden');
  } else {
    abSelect.innerHTML = '<option value="">— no writable address books found —</option>';
    // Encourage user to create a new one
    $('input[name="abChoice"][value="new"]').checked = true;
    toggleAbPanels(true);
  }

  // Toggle panels when user switches choice
  $$('input[name="abChoice"]').forEach(radio => {
    radio.addEventListener('change', () => toggleAbPanels(choiceNew()));
  });

  $('#step1-next').addEventListener('click', async () => {
    if (choiceNew()) {
      const name = $('#new-ab-name').value.trim();
      if (!name) { showFieldError('#new-ab-name', 'Please enter a name.'); return; }

      // Create address book via Thunderbird API
      try {
        const newId = await messenger.addressBooks.create({ name });
        wizard.settings.addressBookId   = newId;
        wizard.settings.addressBookName = name;
      } catch (e) {
        abError.textContent = `Could not create address book: ${e.message}`;
        abError.classList.remove('hidden');
        return;
      }
    } else {
      const id = abSelect.value;
      if (!id) { abError.textContent = 'Please select an address book.'; abError.classList.remove('hidden'); return; }
      wizard.settings.addressBookId   = id;
      wizard.settings.addressBookName = abSelect.options[abSelect.selectedIndex].text;
    }
    showStep(2);
  });
}

function toggleAbPanels(isNew) {
  $('#existing-ab-panel').classList.toggle('hidden', isNew);
  $('#new-ab-panel').classList.toggle('hidden', !isNew);
}

// ── Step 2: Odoo connection ───────────────────────────────────────────────────

function initStep2() {
  const urlInput    = $('#odoo-url');
  const dbSelect    = $('#odoo-db');
  const dbManual    = $('#odoo-db-manual');
  const toggleDbBtn = $('#toggle-db-input');
  const passInput   = $('#odoo-pass');
  const statusBar   = $('#conn-status');
  let   manualDb    = false;

  // Pre-fill from saved settings
  if (wizard.settings.odooUrl)      urlInput.value    = wizard.settings.odooUrl;
  if (wizard.settings.odooUsername) $('#odoo-user').value = wizard.settings.odooUsername;

  // Fetch databases
  $('#fetch-dbs').addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) { setStatus(statusBar, 'error', 'Enter a URL first.'); return; }

    setStatus(statusBar, 'info', 'Fetching databases…');
    const res = await messenger.runtime.sendMessage({ action: 'getDatabases', url });

    if (res.success && res.databases.length > 0) {
      dbSelect.innerHTML = res.databases
        .map(db => `<option value="${escHtml(db)}">${escHtml(db)}</option>`)
        .join('');
      setStatus(statusBar, 'success', `Found ${res.databases.length} database(s).`);
    } else {
      // Odoo 16+ and hosted instances (odoo.com) disable /web/database/list.
      // Switch to manual entry automatically and give a helpful hint.
      switchToManualDb();
      const hint = guessDbName(urlInput.value.trim());
      if (hint) dbManual.value = hint;
      setStatus(statusBar, 'info',
        'Database list is not available on this server (this is normal for Odoo.com and Odoo 16+). ' +
        'Please type your database name below.' +
        (hint ? ` We pre-filled a guess: "${hint}".` : '')
      );
    }
  });

  // Toggle manual DB entry
  toggleDbBtn.addEventListener('click', () => {
    if (manualDb) switchToDropdownDb(); else switchToManualDb();
  });

  function switchToManualDb() {
    manualDb = true;
    dbSelect.classList.add('hidden');
    dbManual.classList.remove('hidden');
    toggleDbBtn.textContent = 'Use dropdown';
  }

  function switchToDropdownDb() {
    manualDb = false;
    dbSelect.classList.remove('hidden');
    dbManual.classList.add('hidden');
    toggleDbBtn.textContent = 'Type manually';
  }

  /**
   * For odoo.com SaaS the database name is typically the subdomain.
   * e.g. https://mycompany.odoo.com → "mycompany"
   */
  function guessDbName(url) {
    try {
      const host = new URL(url).hostname; // e.g. mycompany.odoo.com
      const sub  = host.split('.')[0];
      // Only suggest if it looks like a real subdomain, not "www" or an IP
      if (sub && sub !== 'www' && !/^\d+$/.test(sub)) return sub;
    } catch { /* ignore */ }
    return '';
  }

  // ── Auth mode toggle (password vs API key) ──────────────────────────────
  const apikeyRow   = $('#odoo-apikey-row');
  const apikeyLabel = $('#odoo-apikey-label');
  const apikeyInput = $('#odoo-apikey');
  const apikeyHint  = $('#apikey-hint');
  const passLabel   = $('#odoo-pass-label');

  function getAuthMode() {
    return $('input[name="authMode"]:checked').value;
  }

  function applyAuthMode(mode) {
    const isApiKey = mode === 'apikey';
    passInput.closest('.input-group').classList.toggle('hidden', isApiKey);
    passLabel.classList.toggle('hidden', isApiKey);
    apikeyRow.classList.toggle('hidden', !isApiKey);
    apikeyLabel.classList.toggle('hidden', !isApiKey);
    apikeyHint.classList.toggle('hidden', !isApiKey);
  }

  $$('input[name="authMode"]').forEach(r =>
    r.addEventListener('change', () => applyAuthMode(getAuthMode()))
  );

  // Pre-fill auth mode from saved settings
  if (wizard.settings.odooApiKey) {
    $('input[name="authMode"][value="apikey"]').checked = true;
    apikeyInput.value = wizard.settings.odooApiKey;
    applyAuthMode('apikey');
  }

  // Show / hide password
  $('#toggle-pass').addEventListener('click', () => {
    passInput.type = passInput.type === 'password' ? 'text' : 'password';
  });
  $('#toggle-apikey').addEventListener('click', () => {
    apikeyInput.type = apikeyInput.type === 'password' ? 'text' : 'password';
  });

  // Test connection
  $('#test-connection').addEventListener('click', async () => {
    const s = readStep2();
    if (!s) return;
    setStatus(statusBar, 'info', 'Testing connection…');
    const res = await messenger.runtime.sendMessage({ action: 'testConnection', settings: s });
    if (res.success) {
      setStatus(statusBar, 'success', `Connected! Logged in as "${escHtml(res.name)}" (uid: ${res.uid}).`);
    } else {
      setStatus(statusBar, 'error', `Connection failed: ${res.error}`);
    }
  });

  $('#step2-back').addEventListener('click', () => showStep(1));

  $('#step2-next').addEventListener('click', async () => {
    const s = readStep2();
    if (!s) return;
    setStatus(statusBar, 'info', 'Verifying credentials…');
    const res = await messenger.runtime.sendMessage({ action: 'testConnection', settings: s });
    if (!res.success) {
      setStatus(statusBar, 'error', `Cannot proceed: ${res.error}`);
      return;
    }
    hideStatus(statusBar);
    Object.assign(wizard.settings, s);
    showStep(3);
  });

  function readStep2() {
    const url    = urlInput.value.trim();
    const db     = manualDb ? dbManual.value.trim() : dbSelect.value;
    const user   = $('#odoo-user').value.trim();
    const mode   = getAuthMode();
    const pass   = passInput.value;
    const apikey = apikeyInput.value.trim();

    if (!url)  { setStatus(statusBar, 'error', 'Please enter the Odoo URL.');         return null; }
    if (!db)   { setStatus(statusBar, 'error', 'Please select or enter a database.');  return null; }
    if (!user) { setStatus(statusBar, 'error', 'Please enter a username.');            return null; }

    if (mode === 'apikey') {
      if (!apikey) { setStatus(statusBar, 'error', 'Please paste your Odoo API key.'); return null; }
      return { odooUrl: url, odooDb: db, odooUsername: user, odooPassword: '', odooApiKey: apikey };
    } else {
      if (!pass) { setStatus(statusBar, 'error', 'Please enter a password.');          return null; }
      return { odooUrl: url, odooDb: db, odooUsername: user, odooPassword: pass, odooApiKey: '' };
    }
  }
}

// ── Step 3: Sync settings ─────────────────────────────────────────────────────

function initStep3() {
  const filterSel   = $('#sync-filter');
  const intervalIn  = $('#sync-interval');
  const conflictSel = $('#conflict-resolution');
  const notifCheck  = $('#show-notifications');

  // Pre-fill
  filterSel.value   = wizard.settings.syncFilter;
  intervalIn.value  = wizard.settings.syncIntervalMinutes;
  conflictSel.value = wizard.settings.conflictResolution;
  notifCheck.checked = wizard.settings.showNotifications;

  $('#step3-back').addEventListener('click', () => showStep(2));

  $('#step3-next').addEventListener('click', async () => {
    const interval = parseInt(intervalIn.value, 10);
    if (isNaN(interval) || interval < 5) {
      intervalIn.reportValidity();
      return;
    }

    wizard.settings.syncFilter           = filterSel.value;
    wizard.settings.syncIntervalMinutes  = interval;
    wizard.settings.conflictResolution   = conflictSel.value;
    wizard.settings.showNotifications    = notifCheck.checked;

    // Save settings
    await messenger.runtime.sendMessage({ action: 'saveSettings', settings: wizard.settings });

    // Move to sync step
    showStep(4);
    startInitialSync();
  });
}

// ── Step 4: Initial sync ──────────────────────────────────────────────────────

async function startInitialSync() {
  const progressPanel = $('#sync-progress-panel');
  const resultPanel   = $('#sync-result-panel');
  const progressMsg   = $('#sync-progress-msg');
  const resultIcon    = $('#sync-result-icon');
  const resultMsg     = $('#sync-result-msg');
  const errorList     = $('#sync-error-list');
  const backBtn       = $('#step4-back');
  const doneBtn       = $('#step4-done');
  const retryBtn      = $('#step4-retry');

  progressPanel.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  backBtn.classList.add('hidden');
  doneBtn.classList.add('hidden');
  retryBtn.classList.add('hidden');

  // Listen for progress updates
  const progressListener = (msg) => {
    if (msg.action === 'syncProgress') {
      progressMsg.textContent = msg.message;
    }
  };
  messenger.runtime.onMessage.addListener(progressListener);

  const res = await messenger.runtime.sendMessage({ action: 'sync' });
  messenger.runtime.onMessage.removeListener(progressListener);

  progressPanel.classList.add('hidden');
  resultPanel.classList.remove('hidden');

  if (res.success) {
    const r = res.result;
    resultIcon.textContent = '✅';
    resultMsg.textContent  =
      `Sync complete! Created ${r.created} contact(s), updated ${r.updated}.`;

    if (r.errors && r.errors.length > 0) {
      errorList.innerHTML = r.errors.map(e => `<li>${escHtml(e)}</li>`).join('');
      errorList.classList.remove('hidden');
      resultIcon.textContent = '⚠️';
    }

    doneBtn.classList.remove('hidden');
  } else {
    resultIcon.textContent = '❌';
    resultMsg.textContent  = `Sync failed: ${res.error}`;
    backBtn.classList.remove('hidden');
    retryBtn.classList.remove('hidden');
  }

  doneBtn.addEventListener('click', () => window.close());

  backBtn.addEventListener('click', () => {
    resultPanel.classList.add('hidden');
    showStep(3);
  });

  retryBtn.addEventListener('click', () => {
    resultPanel.classList.add('hidden');
    progressPanel.classList.remove('hidden');
    retryBtn.classList.add('hidden');
    backBtn.classList.add('hidden');
    startInitialSync();
  });
}

// ── Configured view (shown when already set up) ───────────────────────────────

async function showConfiguredView(settings) {
  $('#step-nav').classList.add('hidden');
  $$('.step').forEach(el => el.classList.add('hidden'));
  const view = $('#configured-view');
  view.classList.remove('hidden');

  const summary = $('#config-summary');
  summary.innerHTML = [
    ['Address Book', escHtml(settings.addressBookName || settings.addressBookId)],
    ['Odoo URL',     escHtml(settings.odooUrl)],
    ['Database',     escHtml(settings.odooDb)],
    ['Username',     escHtml(settings.odooUsername)],
    ['Sync filter',  escHtml(syncFilterLabel(settings.syncFilter))],
    ['Sync interval', `Every ${settings.syncIntervalMinutes} minutes`],
    ['Conflict',     settings.conflictResolution === 'odoo' ? 'Odoo wins' : 'Thunderbird wins']
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const statusBar = $('#configured-status');

  $('#reconfigure-btn').addEventListener('click', () => {
    // Reload as wizard with pre-filled values
    prefillWizardFromSettings(settings);
    view.classList.add('hidden');
    $('#step-nav').classList.remove('hidden');
    showStep(1);
  });

  $('#reset-sync-btn').addEventListener('click', async () => {
    if (!confirm('Reset sync state? All contact links will be lost and the next sync will re-match contacts from scratch.')) return;
    await messenger.runtime.sendMessage({ action: 'resetSync' });
    setStatus(statusBar, 'success', 'Sync state reset. Next sync will re-match all contacts.');
  });

  $('#sync-now-btn').addEventListener('click', async () => {
    setStatus(statusBar, 'info', 'Syncing…');
    const res = await messenger.runtime.sendMessage({ action: 'sync' });
    if (res.success) {
      const r = res.result;
      setStatus(statusBar, 'success',
        `Done! Created ${r.created}, updated ${r.updated}` +
        (r.errors?.length ? `, ${r.errors.length} error(s)` : '') + '.');
    } else {
      setStatus(statusBar, 'error', `Sync failed: ${res.error}`);
    }
  });
}

function prefillWizardFromSettings(s) {
  wizard.settings = { ...wizard.settings, ...s };
}

function syncFilterLabel(v) {
  return {
    individuals_with_email: 'Individual contacts with email',
    all_with_email:         'All partners with email',
    all:                    'All partners'
  }[v] || v;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showFieldError(selector, msg) {
  const el = $(selector);
  el.setCustomValidity(msg);
  el.reportValidity();
  el.addEventListener('input', () => el.setCustomValidity(''), { once: true });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  const res = await messenger.runtime.sendMessage({ action: 'getSettings' });
  const saved = res;

  if (saved && saved.configured) {
    Object.assign(wizard.settings, saved);
    await showConfiguredView(saved);
  } else {
    if (saved) Object.assign(wizard.settings, saved);
    showStep(1);
    await initStep1();
    initStep2();
    initStep3();
  }
})();
