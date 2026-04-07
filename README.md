# Odoo Address Book Sync

A Mozilla Thunderbird extension that performs a **two-way sync** between a Thunderbird address book and the contacts in an Odoo instance.

## Features

- **Two-way sync** — changes made in either Odoo or Thunderbird are detected and propagated to the other side
- **Periodic sync** — runs automatically on a configurable interval (default: every 30 minutes)
- **API key authentication** — supports Odoo accounts with TOTP/2FA enabled via Odoo API keys, bypassing the need to enter a one-time code
- **First-run matching** — on the initial sync, existing contacts on both sides are matched by email address rather than creating duplicates
- **Odoo version resilience** — checks which fields actually exist on `res.partner` before fetching, so it won't break if Odoo removes or renames fields in future versions (tested against Odoo 19)
- **Manual sync** — available at any time from the toolbar popup

## Requirements

- Mozilla Thunderbird 115 or later
- Odoo 14 or later (tested against Odoo 19)

## Installation

1. Download the latest `OdooAddressBook.xpi` from the [Releases](../../releases) page
2. In Thunderbird, open **Add-ons and Themes** (via the menu or `Ctrl+Shift+A`)
3. Click the gear icon → **Install Add-on From File…**
4. Select the downloaded `.xpi` file and click **Add**

## Setup

The first time the extension runs, a setup wizard opens automatically. It has four steps:

### Step 1 — Address Book
Choose an existing Thunderbird address book to sync, or create a new dedicated one (e.g. "Odoo Contacts").

### Step 2 — Odoo Connection
Enter your Odoo instance details:

| Field | Description |
|---|---|
| Odoo URL | The full URL of your Odoo instance, e.g. `https://mycompany.odoo.com` |
| Database | Click **Fetch Databases** to auto-discover, or type it manually. For Odoo.com SaaS the database name is typically your subdomain. |
| Username / E-mail | Your Odoo login email |
| Authentication | Choose **Password** for standard accounts, or **API Key** for accounts with 2FA/TOTP enabled |

**Creating an API key in Odoo:**
1. Add `?debug=1` to your Odoo URL to enable developer mode (if the Technical menu is missing)
2. Go to **Settings → Technical → API Keys → New**
3. Give the key a name (e.g. "Thunderbird Sync"), confirm with your password and TOTP code
4. Copy the key — it is only shown once

### Step 3 — Sync Settings

| Setting | Description |
|---|---|
| Odoo contacts to sync | Filter which Odoo partners are included: individual contacts with email (default), all partners with email, or all partners |
| Sync interval | How often the automatic sync runs (minimum 5 minutes, default 30) |
| When both sides changed | Conflict resolution: **Odoo wins** (default) or **Thunderbird wins** |
| Notifications | Show a Thunderbird notification when a sync completes |

### Step 4 — Initial Sync
The extension runs an initial sync immediately, showing live progress. Once complete, click **Done**.

## How the Sync Works

The extension uses Odoo's **XML-RPC API** (the official external API) for all communication with Odoo. This is stateless — credentials are sent with every call — which is why API keys work cleanly without session management or TOTP prompts.

On each sync run:

1. All contacts from the selected Thunderbird address book are fetched
2. All matching Odoo partners are fetched (according to the configured filter)
3. Each previously-linked pair is checked for changes by comparing a snapshot of the contact data against what was stored at the last sync
4. **Thunderbird → Odoo:** contacts changed in Thunderbird since last sync are written to Odoo
5. **Odoo → Thunderbird:** contacts changed in Odoo since last sync are written to Thunderbird
6. **New Thunderbird contacts** not yet in Odoo are matched by email address first; if no match is found, a new Odoo partner is created
7. **New Odoo partners** not yet in Thunderbird are matched by email address first; if no match is found, a new Thunderbird contact is created
8. The sync state (contact links and snapshots) is saved to extension storage

### Conflict resolution

If the same contact is edited on both sides between syncs, the configured conflict resolution setting determines the winner (default: Odoo wins).

### Deletions

Deletions are **not** propagated. If a contact is deleted in one place it will not be deleted in the other. This is intentional — automatic deletions across both systems are too risky without an explicit confirmation step.

## Field Mapping

| Thunderbird | Odoo (`res.partner`) |
|---|---|
| Display Name | `name` |
| First / Last Name | split from `name` |
| Primary Email | `email` |
| Work Phone | `phone` |
| Mobile | `mobile` (if field exists) |
| Job Title | `function` |
| Company | `parent_id` (display name) |
| Work Address | `street` |
| Work Address 2 | `street2` |
| Work City | `city` |
| Work State | `state_id` (display name) |
| Work Postcode | `zip` |
| Work Country | `country_id` (display name) |
| Web Page | `website` |
| Notes | `comment` |

## Tips

- **Reset Sync State** (available in Settings) is useful if something gets out of sync — it clears all contact links and the next sync re-matches everything from scratch by email address
- The toolbar popup shows the current sync status, the time of the last sync, and a **Sync Now** button for on-demand syncing
- If you see errors after an Odoo upgrade, try Reset Sync State followed by a manual sync

## Development

The extension is an unpackaged WebExtension (Manifest V2). To build the installable `.xpi`:

```bash
cd OdooAddressBook
zip -r ../OdooAddressBook.xpi . --exclude "*.git*"
```

### File structure

```
OdooAddressBook/
├── manifest.json           # Extension manifest (MV2, Thunderbird 91+)
├── background.js           # Event hub: install hook, alarm, message router
├── src/
│   ├── odooApi.js          # Odoo XML-RPC client
│   ├── contactMapper.js    # Bidirectional field mapping + vCard builder
│   └── syncEngine.js       # Two-way sync algorithm
├── options/                # Setup wizard (4-step)
├── popup/                  # Toolbar popup
└── icons/
```

## Licence

MIT
