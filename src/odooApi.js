/**
 * Odoo API client using XML-RPC (the official Odoo external API).
 *
 * Why XML-RPC and not JSON-RPC?
 *   Odoo's JSON-RPC endpoint is session-based (cookie auth) and will reject
 *   requests when TOTP/2FA is enabled on the account.  The XML-RPC endpoint
 *   at /xmlrpc/2/ is stateless — credentials are sent with every call — and
 *   explicitly supports API keys, bypassing TOTP entirely.
 *
 * Endpoints used:
 *   POST /xmlrpc/2/db      – database listing  (no auth required)
 *   POST /xmlrpc/2/common  – authentication
 *   POST /xmlrpc/2/object  – model method calls (search_read, create, write, …)
 */

// ── Minimal XML-RPC helper ────────────────────────────────────────────────────

const XmlRpc = (() => {

  // ── Serialisation ───────────────────────────────────────────────────────────

  function escXml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function valueXml(v) {
    if (v === null || v === undefined) return '<value><nil/></value>';
    if (v === false)  return '<value><boolean>0</boolean></value>';
    if (v === true)   return '<value><boolean>1</boolean></value>';
    if (typeof v === 'number') {
      return Number.isInteger(v)
        ? `<value><int>${v}</int></value>`
        : `<value><double>${v}</double></value>`;
    }
    if (typeof v === 'string') {
      return `<value><string>${escXml(v)}</string></value>`;
    }
    if (Array.isArray(v)) {
      return `<value><array><data>${v.map(valueXml).join('')}</data></array></value>`;
    }
    if (typeof v === 'object') {
      const members = Object.entries(v)
        .map(([k, val]) => `<member><name>${escXml(k)}</name>${valueXml(val)}</member>`)
        .join('');
      return `<value><struct>${members}</struct></value>`;
    }
    return `<value><string>${escXml(String(v))}</string></value>`;
  }

  function buildCall(method, params) {
    const paramsXml = params.map(p => `<param>${valueXml(p)}</param>`).join('');
    return `<?xml version="1.0"?>\n` +
      `<methodCall><methodName>${escXml(method)}</methodName>` +
      `<params>${paramsXml}</params></methodCall>`;
  }

  // ── Deserialisation ─────────────────────────────────────────────────────────

  function parseValue(node) {
    if (!node) return null;
    // A <value> element may contain a type element or bare text (= string)
    const child = node.firstElementChild;
    if (!child) return node.textContent;

    switch (child.tagName.toLowerCase()) {
      case 'string':   return child.textContent;
      case 'int':
      case 'i4':
      case 'i8':       return parseInt(child.textContent, 10);
      case 'double':   return parseFloat(child.textContent);
      case 'boolean':  return child.textContent.trim() === '1';
      case 'nil':      return null;
      case 'array': {
        const data = child.querySelector('data');
        if (!data) return [];
        return [...data.children].map(parseValue);
      }
      case 'struct': {
        const obj = {};
        for (const member of child.querySelectorAll(':scope > member')) {
          const name = member.querySelector('name')?.textContent ?? '';
          const val  = member.querySelector('value');
          obj[name]  = parseValue(val);
        }
        return obj;
      }
      default:
        return child.textContent;
    }
  }

  function parseResponse(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

    const parseErr = doc.querySelector('parsererror');
    if (parseErr) throw new Error(`XML parse error: ${parseErr.textContent.slice(0, 120)}`);

    const fault = doc.querySelector('fault');
    if (fault) {
      const f = parseValue(fault.querySelector('value'));
      throw new Error(f?.faultString ?? 'XML-RPC fault');
    }

    const valueEl = doc.querySelector('methodResponse > params > param > value');
    return parseValue(valueEl);
  }

  // ── HTTP call ───────────────────────────────────────────────────────────────

  async function call(baseUrl, path, method, params) {
    const body = buildCall(method, params);
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', 'Accept': 'text/xml' },
        body
      });
    } catch (netErr) {
      throw new Error(`Network error: ${netErr.message}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    return parseResponse(text);
  }

  return { call };
})();

// ── OdooAPI class ─────────────────────────────────────────────────────────────

class OdooAPI {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uid        = null;
    this.db         = null;
    this._credential = null; // API key or password used for every call
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  /**
   * Authenticate via XML-RPC.
   *
   * Pass `apiKey` for accounts with 2FA/TOTP — API keys bypass TOTP
   * entirely.  For accounts without 2FA, `password` is used.
   *
   * Returns { success, uid, name, error }.
   */
  async authenticate(db, username, password, apiKey = '') {
    const credential = (apiKey || '').trim() || password;
    try {
      const uid = await XmlRpc.call(
        this.baseUrl, '/xmlrpc/2/common',
        'authenticate',
        [db, username, credential, {}]
      );

      if (!uid || uid === false) {
        return {
          success: false,
          error: 'Authentication failed — check your username, database, and password / API key.'
        };
      }

      this.uid         = uid;
      this.db          = db;
      this._username   = username;
      this._credential = credential;

      // Fetch the user's display name
      let name = username;
      try {
        const info = await this._execute('res.users', 'read', [[uid]], { fields: ['name'] });
        if (info?.[0]?.name) name = info[0].name;
      } catch { /* non-critical */ }

      return { success: true, uid, name };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ── Database listing ──────────────────────────────────────────────────────

  async getDatabases() {
    try {
      const list = await XmlRpc.call(this.baseUrl, '/xmlrpc/2/db', 'list', []);
      return { success: true, databases: Array.isArray(list) ? list : [] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ── Generic execute_kw ────────────────────────────────────────────────────

  async _execute(model, method, args, kwargs = {}) {
    if (!this.uid) throw new Error('Not authenticated — call authenticate() first.');
    return XmlRpc.call(
      this.baseUrl, '/xmlrpc/2/object',
      'execute_kw',
      [this.db, this.uid, this._credential, model, method, args, kwargs]
    );
  }

  // ── ORM helpers ───────────────────────────────────────────────────────────

  async searchRead(model, domain, fields, options = {}) {
    return this._execute(model, 'search_read', [domain], {
      fields,
      limit:  options.limit  ?? 0,
      offset: options.offset ?? 0,
      order:  options.order  ?? 'id asc'
    });
  }

  async create(model, values) {
    const result = await this._execute(model, 'create', [values]);
    // XML-RPC create returns an int directly
    return Array.isArray(result) ? result[0] : result;
  }

  async write(model, ids, values) {
    return this._execute(model, 'write', [ids, values]);
  }

  async unlink(model, ids) {
    return this._execute(model, 'unlink', [ids]);
  }

  // ── Partner helpers ───────────────────────────────────────────────────────

  /**
   * Fields we want to sync. Some may not exist in all Odoo versions
   * (e.g. 'mobile' was removed from res.partner in Odoo 19).
   * We intersect this list with the model's actual fields at runtime.
   */
  static DESIRED_PARTNER_FIELDS = [
    'id', 'name', 'email', 'phone', 'mobile', 'function',
    'street', 'street2', 'city', 'zip',
    'country_id', 'state_id',
    'website', 'comment',
    'is_company', 'parent_id',
    'write_date'
  ];

  /**
   * Returns the subset of DESIRED_PARTNER_FIELDS that actually exist on
   * res.partner in this Odoo instance. Result is cached after first call.
   */
  async getAvailablePartnerFields() {
    if (this._partnerFields) return this._partnerFields;
    // fields_get returns a dict of {fieldName: {…metadata…}}
    const available = await this._execute('res.partner', 'fields_get', [], { attributes: ['string'] });
    this._partnerFields = OdooAPI.DESIRED_PARTNER_FIELDS.filter(f => f in available);
    return this._partnerFields;
  }

  async getPartners(extraDomain = []) {
    const fields = await this.getAvailablePartnerFields();
    return this.searchRead('res.partner', extraDomain, fields);
  }

  async createPartner(values) { return this.create('res.partner', values); }
  async updatePartner(id, values) { return this.write('res.partner', [id], values); }
  async deletePartner(id) { return this.unlink('res.partner', [id]); }

  // ── Country / State lookup (cached) ──────────────────────────────────────

  async getCountryMap() {
    if (this._countryMap) return this._countryMap;
    const countries = await this.searchRead('res.country', [], ['id', 'name']);
    this._countryMap = {};
    for (const c of countries) this._countryMap[c.name.toLowerCase()] = c.id;
    return this._countryMap;
  }

  async lookupCountryId(name) {
    if (!name) return false;
    const map = await this.getCountryMap();
    return map[name.toLowerCase()] ?? false;
  }

  async getStateMap(countryId) {
    if (!countryId) return {};
    const key = `_stateMap_${countryId}`;
    if (this[key]) return this[key];
    const states = await this.searchRead(
      'res.country.state', [['country_id', '=', countryId]], ['id', 'name']
    );
    this[key] = {};
    for (const s of states) this[key][s.name.toLowerCase()] = s.id;
    return this[key];
  }
}
