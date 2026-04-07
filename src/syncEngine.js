/**
 * Two-way sync engine between a Thunderbird address book and Odoo res.partner.
 *
 * Sync state is persisted in messenger.storage.local under the key
 * "syncState".  The state tracks every linked pair:
 *
 *   syncState.pairs = {
 *     "<tbContactId>": {
 *       odooId:      <number>,
 *       tbSnap:      <ContactMapper.tbSnapshot>,   // at last sync
 *       odooSnap:    <ContactMapper.odooSnapshot>, // at last sync
 *       syncedAt:    <ISO string>
 *     },
 *     ...
 *   }
 *
 * Algorithm (per sync run):
 *   1. Fetch all Thunderbird contacts from the configured address book.
 *   2. Fetch all Odoo partners that match the configured filter.
 *   3. Walk each linked pair → detect changes → push / pull / skip / conflict.
 *   4. Walk unlinked TB contacts → match by email → create in Odoo if no match.
 *   5. Walk unlinked Odoo partners → match by email → create in TB if no match.
 *   6. Persist updated sync state.
 *
 * Conflict resolution: if both sides changed since last sync, the side with
 * the more recent Odoo write_date wins (configurable: "odoo" | "thunderbird").
 */

const SyncEngine = (() => {

  // ── Storage helpers ──────────────────────────────────────────────────────────

  async function loadSyncState() {
    const data = await messenger.storage.local.get('syncState');
    return data.syncState || { pairs: {} };
  }

  async function saveSyncState(state) {
    await messenger.storage.local.set({ syncState: state });
  }

  // ── Thunderbird address book helpers ─────────────────────────────────────────

  /**
   * Return all contacts in the given address book as an array of
   * { id, properties } objects.
   */
  async function getTbContacts(addressBookId) {
    const nodes = await messenger.contacts.list(addressBookId);
    return nodes.map(node => ({
      id: node.id,
      // TB 115+ still populates node.properties for backwards compat (reading),
      // even when the contact was created via vCard.
      properties: node.properties || {}
    }));
  }

  /**
   * Write a contact to Thunderbird using vCard 4.0 format.
   *
   * Thunderbird 115+ removed the legacy `properties` API for writes.
   * Passing `{ properties: {...} }` now throws "Value must either: be a
   * string value, or be a null value" for every contact regardless of the
   * actual values.  The only supported write path is `{ vCard: "..." }`.
   */
  async function createTbContact(addressBookId, props) {
    const vCard = ContactMapper.buildVCard(props);
    return await messenger.contacts.create(addressBookId, { vCard });
  }

  async function updateTbContact(contactId, props) {
    const vCard = ContactMapper.buildVCard(props);
    await messenger.contacts.update(contactId, { vCard });
  }

  async function deleteTbContact(contactId) {
    await messenger.contacts.delete(contactId);
  }

  // ── Odoo helpers with country/state resolution ────────────────────────────────

  /**
   * Build the Odoo-side values dict from TB props, resolving country_id and
   * state_id via the OdooAPI instance.
   */
  async function resolveOdooValues(rawValues, odooApi) {
    const values = { ...rawValues };

    // Remove internal keys used only for lookups
    delete values._countryName;
    delete values._stateName;
    delete values._companyName;

    if (rawValues._countryName) {
      const countryId = await odooApi.lookupCountryId(rawValues._countryName);
      if (countryId) {
        values.country_id = countryId;

        if (rawValues._stateName) {
          const stateMap = await odooApi.getStateMap(countryId);
          const stateId  = stateMap[rawValues._stateName.toLowerCase()];
          if (stateId) values.state_id = stateId;
        }
      }
    }

    // Remove false-y fields to avoid overwriting with empty in Odoo
    for (const key of Object.keys(values)) {
      if (values[key] === false || values[key] === '') {
        delete values[key];
      }
    }

    // Strip fields that don't exist on this Odoo instance (e.g. 'mobile'
    // was removed from res.partner in Odoo 19).
    const available = await odooApi.getAvailablePartnerFields();
    const availableSet = new Set(available);
    for (const key of Object.keys(values)) {
      if (!availableSet.has(key)) delete values[key];
    }

    return values;
  }

  // ── Email-based matching ──────────────────────────────────────────────────────

  function buildEmailIndex(items, getEmail) {
    const idx = {};
    for (const item of items) {
      const email = (getEmail(item) || '').trim().toLowerCase();
      if (email) idx[email] = item;
    }
    return idx;
  }

  // ── Core sync logic ──────────────────────────────────────────────────────────

  /**
   * Main entry point.  Called by background.js on each alarm tick.
   *
   * @param {object} settings  The settings object from storage
   * @param {function} [onProgress]  Optional progress callback: (message) => void
   * @returns {object}  { created, updated, errors, skipped }
   */
  async function sync(settings, onProgress = () => {}) {
    const stats = { created: 0, updated: 0, skipped: 0, errors: [] };

    // ── 1. Connect to Odoo ───────────────────────────────────────────────────
    onProgress('Connecting to Odoo…');
    const odooApi = new OdooAPI(settings.odooUrl);
    const authResult = await odooApi.authenticate(
      settings.odooDb,
      settings.odooUsername,
      settings.odooPassword,
      settings.odooApiKey || ''
    );
    if (!authResult.success) {
      throw new Error(`Odoo authentication failed: ${authResult.error}`);
    }

    // ── 2. Fetch contacts ────────────────────────────────────────────────────
    onProgress('Fetching Thunderbird contacts…');
    const tbContacts = await getTbContacts(settings.addressBookId);

    onProgress('Fetching Odoo partners…');
    const oodooDomain = buildOodooDomain(settings.syncFilter);
    const odooPartners = await odooApi.getPartners(oodooDomain);

    // ── 3. Build lookup maps ─────────────────────────────────────────────────
    const odooById  = new Map(odooPartners.map(p => [p.id, p]));
    const tbById    = new Map(tbContacts.map(c => [c.id, c]));
    const odooEmail = buildEmailIndex(odooPartners, p => p.email);
    const tbEmail   = buildEmailIndex(tbContacts,   c => c.properties.PrimaryEmail);

    // ── 4. Load sync state ───────────────────────────────────────────────────
    const state     = await loadSyncState();
    const pairs     = state.pairs;
    const linkedOdooIds = new Set(Object.values(pairs).map(p => p.odooId));
    const linkedTbIds   = new Set(Object.keys(pairs));

    const now = new Date().toISOString();

    // ── 5. Process existing linked pairs ────────────────────────────────────
    onProgress('Syncing linked contacts…');
    for (const [tbId, pairState] of Object.entries(pairs)) {
      const tbContact = tbById.get(tbId);
      const odooPartner = odooById.get(pairState.odooId);

      // TB contact was deleted
      if (!tbContact) {
        delete pairs[tbId];
        stats.skipped++;
        continue;
      }

      // Odoo partner was deleted
      if (!odooPartner) {
        delete pairs[tbId];
        stats.skipped++;
        continue;
      }

      // Detect changes
      const currentTbSnap   = ContactMapper.tbSnapshot(tbContact.properties);
      const currentOdooSnap = ContactMapper.odooSnapshot(odooPartner);
      const tbChanged   = ContactMapper.hasChanged(currentTbSnap,   pairState.tbSnap);
      const odooChanged = ContactMapper.hasChanged(currentOdooSnap, pairState.odooSnap);

      if (!tbChanged && !odooChanged) {
        stats.skipped++;
        continue;
      }

      const conflictWinner = settings.conflictResolution || 'odoo';

      try {
        if (tbChanged && odooChanged) {
          // Conflict — honour configured resolution
          if (conflictWinner === 'thunderbird') {
            await pushTbToOdoo(tbContact, odooPartner.id, odooApi);
            // TB data is authoritative; Odoo now mirrors it
            pairState.tbSnap   = currentTbSnap;
            pairState.odooSnap = currentTbSnap; // Odoo will reflect the same values
          } else {
            // Odoo is authoritative
            await pullOdooToTb(odooPartner, tbContact.id);
            // After pull, TB props mirror Odoo's odooToTb output → snapshot via odooToTb
            const mirroredTbSnap = ContactMapper.tbSnapshot(
              ContactMapper.odooToTb(odooPartner)
            );
            pairState.tbSnap   = mirroredTbSnap;
            pairState.odooSnap = currentOdooSnap;
          }
          stats.updated++;

        } else if (tbChanged) {
          await pushTbToOdoo(tbContact, odooPartner.id, odooApi);
          pairState.tbSnap   = currentTbSnap;
          pairState.odooSnap = currentTbSnap; // Odoo mirrors TB after write
          stats.updated++;

        } else {
          // odooChanged only
          await pullOdooToTb(odooPartner, tbContact.id);
          const mirroredTbSnap = ContactMapper.tbSnapshot(
            ContactMapper.odooToTb(odooPartner)
          );
          pairState.tbSnap   = mirroredTbSnap;
          pairState.odooSnap = currentOdooSnap;
          stats.updated++;
        }

        pairState.syncedAt = now;
      } catch (err) {
        stats.errors.push(`Update "${odooPartner.name}": ${err.message}`);
      }
    }

    // ── 6. New Thunderbird contacts → Odoo ──────────────────────────────────
    onProgress('Uploading new Thunderbird contacts to Odoo…');
    for (const tbContact of tbContacts) {
      if (linkedTbIds.has(tbContact.id)) continue;
      const email = (tbContact.properties.PrimaryEmail || '').trim().toLowerCase();

      // Try email-based match with an existing Odoo partner
      const matchedOdoo = email ? odooEmail[email] : null;
      if (matchedOdoo && !linkedOdooIds.has(matchedOdoo.id)) {
        // Link without writing (snapshot both sides, let next sync handle deltas)
        pairs[tbContact.id] = {
          odooId:   matchedOdoo.id,
          tbSnap:   ContactMapper.tbSnapshot(tbContact.properties),
          odooSnap: ContactMapper.odooSnapshot(matchedOdoo),
          syncedAt: now
        };
        linkedOdooIds.add(matchedOdoo.id);
        stats.skipped++;
        continue;
      }

      // Create new partner in Odoo
      try {
        const rawValues  = ContactMapper.tbToOdoo(tbContact.properties);
        const odooValues = await resolveOdooValues(rawValues, odooApi);
        const newOdooId  = await odooApi.createPartner(odooValues);

        // Re-fetch to get the canonical snapshot (including computed fields)
        const created = (await odooApi.getPartners([['id', '=', newOdooId]]))[0];
        pairs[tbContact.id] = {
          odooId:   newOdooId,
          tbSnap:   ContactMapper.tbSnapshot(tbContact.properties),
          odooSnap: ContactMapper.odooSnapshot(created || {}),
          syncedAt: now
        };
        linkedOdooIds.add(newOdooId);
        stats.created++;
      } catch (err) {
        stats.errors.push(
          `Create Odoo partner for "${tbContact.properties.DisplayName || tbContact.id}": ${err.message}`
        );
      }
    }

    // ── 7. New Odoo partners → Thunderbird ──────────────────────────────────
    onProgress('Downloading new Odoo contacts to Thunderbird…');
    for (const odooPartner of odooPartners) {
      if (linkedOdooIds.has(odooPartner.id)) continue;
      const email = (odooPartner.email || '').trim().toLowerCase();

      // Email-based match with an existing (unlinked) TB contact
      const matchedTb = email ? tbEmail[email] : null;
      if (matchedTb && !linkedTbIds.has(matchedTb.id)) {
        pairs[matchedTb.id] = {
          odooId:   odooPartner.id,
          tbSnap:   ContactMapper.tbSnapshot(matchedTb.properties),
          odooSnap: ContactMapper.odooSnapshot(odooPartner),
          syncedAt: now
        };
        linkedOdooIds.add(odooPartner.id);
        stats.skipped++;
        continue;
      }

      // Create new contact in Thunderbird
      try {
        const props  = ContactMapper.odooToTb(odooPartner);
        const newTbId = await createTbContact(settings.addressBookId, props);

        pairs[newTbId] = {
          odooId:   odooPartner.id,
          tbSnap:   ContactMapper.tbSnapshot(props),
          odooSnap: ContactMapper.odooSnapshot(odooPartner),
          syncedAt: now
        };
        linkedOdooIds.add(odooPartner.id);
        stats.created++;
      } catch (err) {
        stats.errors.push(
          `Create TB contact for "${odooPartner.name}": ${err.message}`
        );
      }
    }

    // ── 8. Persist state ────────────────────────────────────────────────────
    state.pairs = pairs;
    state.lastSyncTime = now;
    await saveSyncState(state);

    return stats;
  }

  // ── Push / pull helpers ──────────────────────────────────────────────────────

  async function pushTbToOdoo(tbContact, odooId, odooApi) {
    const rawValues  = ContactMapper.tbToOdoo(tbContact.properties);
    const odooValues = await resolveOdooValues(rawValues, odooApi);
    await odooApi.updatePartner(odooId, odooValues);
  }

  async function pullOdooToTb(odooPartner, tbContactId) {
    const props = ContactMapper.odooToTb(odooPartner);
    await updateTbContact(tbContactId, props);
  }

  // ── Domain builder ───────────────────────────────────────────────────────────

  function buildOodooDomain(syncFilter) {
    switch (syncFilter) {
      case 'individuals_with_email':
        return [['is_company', '=', false], ['email', '!=', false]];
      case 'all_with_email':
        return [['email', '!=', false]];
      case 'all':
      default:
        return [];
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  return { sync, loadSyncState, saveSyncState };
})();
