# Server Documentation

Backend API and integration notes for the OOMS server.

## Files

| File | Description |
|------|-------------|
| `finance-registers.md` | Received report, bank list stats, discount CRUD/list APIs |
| `wp_system.md` | WordPress system integration |
| `backup_integration.md` | Backup integration |

## Route mounting (`routes/index.js`)

| Mount path | Router file |
|------------|-------------|
| `/transaction` | `routes/transactions.js` |
| `/expense` | `routes/expense.js` |
| `/capital` | `routes/capital.js` |

Full URL example: `https://server.ooms.in/api/v1/transaction/report/receive`
