/**
 * Bidirectional field mapping between Thunderbird contact properties
 * and Odoo res.partner records.
 *
 * Thunderbird contact properties reference:
 *   DisplayName, FirstName, LastName, NickName
 *   PrimaryEmail, SecondEmail
 *   WorkPhone, HomePhone, FaxNumber, CellularNumber
 *   Company, Department, JobTitle
 *   WorkAddress, WorkAddress2, WorkCity, WorkState, WorkZipCode, WorkCountry
 *   WebPage1, Notes
 *
 * Odoo res.partner fields used:
 *   name, email, phone, mobile, function
 *   street, street2, city, zip, country_id, state_id
 *   website, comment, is_company, parent_id
 */

const ContactMapper = (() => {

  // ── Name helpers ────────────────────────────────────────────────────────────

  /**
   * Split a full name into {firstName, lastName}.
   * "John" → {firstName:"John", lastName:""}
   * "John Doe" → {firstName:"John", lastName:"Doe"}
   * "Mary Jane Watson" → {firstName:"Mary", lastName:"Jane Watson"}
   */
  function splitName(fullName) {
    if (!fullName) return { firstName: '', lastName: '' };
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  /**
   * Build a full name from TB FirstName / LastName / DisplayName.
   */
  function buildOdooName(props) {
    const display = (props.DisplayName || '').trim();
    const first   = (props.FirstName   || '').trim();
    const last    = (props.LastName    || '').trim();

    if (display) return display;
    if (first || last) return [first, last].filter(Boolean).join(' ');
    return props.PrimaryEmail || '(no name)';
  }

  // ── Many2one helpers ────────────────────────────────────────────────────────

  /**
   * Odoo many2one fields are returned as [id, display_name] or false.
   * Extract the display name.
   */
  function m2oName(value) {
    if (!value) return '';
    if (Array.isArray(value)) return value[1] || '';
    return String(value);
  }

  // ── Odoo → Thunderbird ──────────────────────────────────────────────────────

  /**
   * Convert an Odoo res.partner record to Thunderbird contact properties.
   * Returns a plain object whose keys match Thunderbird's ContactProperties.
   */
  function odooToTb(partner) {
    const { firstName, lastName } = splitName(partner.name || '');

    const props = {
      DisplayName:     partner.name    || '',
      FirstName:       firstName,
      LastName:        lastName,
      PrimaryEmail:    partner.email   || '',
      WorkPhone:       partner.phone   || '',
      CellularNumber:  partner.mobile  || '',
      JobTitle:        partner.function || '',
      WorkAddress:     partner.street  || '',
      WorkAddress2:    partner.street2 || '',
      WorkCity:        partner.city    || '',
      WorkZipCode:     partner.zip     || '',
      WorkCountry:     m2oName(partner.country_id),
      WorkState:       m2oName(partner.state_id),
      Company:         m2oName(partner.parent_id),
      WebPage1:        partner.website || '',
      Notes:           partner.comment || ''
    };

    return props;
  }

  // ── Thunderbird → Odoo ──────────────────────────────────────────────────────

  /**
   * Convert Thunderbird contact properties to Odoo partner values.
   * country_id / state_id / parent_id are NOT resolved here — pass an
   * optional resolver object to fill those in asynchronously.
   *
   * @param {object} props   Thunderbird ContactProperties
   * @returns {object}       Odoo field values (scalar fields only)
   */
  function tbToOdoo(props) {
    const name = buildOdooName(props);

    return {
      name:     name,
      email:    props.PrimaryEmail    || false,
      phone:    props.WorkPhone       || false,
      mobile:   props.CellularNumber  || false,
      function: props.JobTitle        || false,
      street:   props.WorkAddress     || false,
      street2:  props.WorkAddress2    || false,
      city:     props.WorkCity        || false,
      zip:      props.WorkZipCode     || false,
      website:  props.WebPage1        || false,
      comment:  props.Notes           || false,
      // country_id and state_id require async lookup — handled by syncEngine
      _countryName: props.WorkCountry || '',
      _stateName:   props.WorkState   || '',
      _companyName: props.Company     || ''
    };
  }

  // ── Comparison / change-detection ───────────────────────────────────────────

  /**
   * Produce a canonical comparison object from Odoo partner data.
   * Only includes fields that participate in the sync.
   */
  function odooSnapshot(partner) {
    return {
      name:     partner.name     || '',
      email:    partner.email    || '',
      phone:    partner.phone    || '',
      mobile:   partner.mobile   || '',
      function: partner.function || '',
      street:   partner.street   || '',
      street2:  partner.street2  || '',
      city:     partner.city     || '',
      zip:      partner.zip      || '',
      country:  m2oName(partner.country_id),
      state:    m2oName(partner.state_id),
      company:  m2oName(partner.parent_id),
      website:  partner.website  || '',
      comment:  partner.comment  || ''
    };
  }

  /**
   * Produce a canonical comparison object from Thunderbird contact properties.
   */
  function tbSnapshot(props) {
    return {
      name:     buildOdooName(props),
      email:    props.PrimaryEmail    || '',
      phone:    props.WorkPhone       || '',
      mobile:   props.CellularNumber  || '',
      function: props.JobTitle        || '',
      street:   props.WorkAddress     || '',
      street2:  props.WorkAddress2    || '',
      city:     props.WorkCity        || '',
      zip:      props.WorkZipCode     || '',
      country:  props.WorkCountry     || '',
      state:    props.WorkState       || '',
      company:  props.Company         || '',
      website:  props.WebPage1        || '',
      comment:  props.Notes           || ''
    };
  }

  /**
   * Returns true if the two snapshots differ.
   */
  function hasChanged(snapshotA, snapshotB) {
    return JSON.stringify(snapshotA) !== JSON.stringify(snapshotB);
  }

  // ── vCard builder (for writing contacts to Thunderbird 115+) ────────────────

  /**
   * Escape a value for use in a vCard text property.
   * Backslashes, semicolons, commas, and newlines are escaped per RFC 6350.
   */
  function escVCard(s) {
    return String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /**
   * Fold a vCard line at 75 octets (RFC 6350 §3.2).
   * Thunderbird accepts unfolded vCards, but we fold anyway to be correct.
   */
  function foldLine(line) {
    if (line.length <= 75) return line;
    const chunks = [];
    chunks.push(line.slice(0, 75));
    let i = 75;
    while (i < line.length) {
      chunks.push(' ' + line.slice(i, i + 74));
      i += 74;
    }
    return chunks.join('\r\n');
  }

  /**
   * Build a vCard 4.0 string from a Thunderbird-style properties object.
   * Used when creating or updating a contact in Thunderbird 115+, where the
   * legacy `properties` API no longer works and `vCard` is required.
   */
  function buildVCard(props) {
    const p = key => String(props[key] || '');

    // FN is required; fall back through available name fields
    const fn = p('DisplayName')
      || [p('FirstName'), p('LastName')].filter(Boolean).join(' ')
      || p('PrimaryEmail')
      || '(no name)';

    const lines = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      foldLine('FN:' + escVCard(fn)),
      // N: family;given;additional;prefix;suffix
      foldLine(`N:${escVCard(p('LastName'))};${escVCard(p('FirstName'))};;;`),
    ];

    if (p('PrimaryEmail'))   lines.push(foldLine('EMAIL;TYPE=WORK:'  + escVCard(p('PrimaryEmail'))));
    if (p('WorkPhone'))      lines.push(foldLine('TEL;TYPE=WORK:'    + escVCard(p('WorkPhone'))));
    if (p('CellularNumber')) lines.push(foldLine('TEL;TYPE=CELL:'    + escVCard(p('CellularNumber'))));
    if (p('HomePhone'))      lines.push(foldLine('TEL;TYPE=HOME:'    + escVCard(p('HomePhone'))));
    if (p('Company'))        lines.push(foldLine('ORG:'              + escVCard(p('Company'))));
    if (p('JobTitle'))       lines.push(foldLine('TITLE:'            + escVCard(p('JobTitle'))));
    if (p('WebPage1'))       lines.push(foldLine('URL:'              + escVCard(p('WebPage1'))));
    if (p('Notes'))          lines.push(foldLine('NOTE:'             + escVCard(p('Notes'))));

    // ADR: ;;street;extended-address;locality;region;postal-code;country
    const hasAddr = p('WorkAddress') || p('WorkCity') || p('WorkZipCode') || p('WorkCountry');
    if (hasAddr) {
      const adr = [
        '',                         // PO box (unused)
        escVCard(p('WorkAddress2')),// extended address
        escVCard(p('WorkAddress')), // street
        escVCard(p('WorkCity')),    // locality
        escVCard(p('WorkState')),   // region
        escVCard(p('WorkZipCode')), // postal code
        escVCard(p('WorkCountry'))  // country
      ].join(';');
      lines.push(foldLine('ADR;TYPE=WORK:' + adr));
    }

    lines.push('END:VCARD');
    return lines.join('\r\n');
  }

  return { odooToTb, tbToOdoo, odooSnapshot, tbSnapshot, hasChanged, buildVCard };
})();
