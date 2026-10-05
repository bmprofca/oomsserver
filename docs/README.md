# Server Documentation

Backend API and integration notes for the OOMS server.

## Files

| File | Description |
|------|-------------|
| `finance-registers.md` | Received report, bank list stats, discount CRUD/list APIs |
| `wp_system.md` | WordPress system integration |
| `backup_integration.md` | Backup integration |
| `in-app-voice-calls.md` | Standalone LiveKit app-to-app voice calling |

## Route mounting (`routes/index.js`)

| Mount path | Router file |
|------------|-------------|
| `/transaction` | `routes/transactions.js` |
| `/expense` | `routes/expense.js` |
| `/capital` | `routes/capital.js` |

Full URL example: `https://server.ooms.in/api/v1/transaction/report/receive`

Voice-call direction support requires the database update in
`database/migrations/20261005_in_app_voice_call_direction.sql`. Apply it with
`npm run migrate:voice-call-direction` before deploying the updated server.
