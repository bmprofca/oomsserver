# AI assistant (multi-provider + MCP): server context

> **Purpose:** Read this before changing anything under `SERVER/ai/`, `routes/ai.js`, the `ai_*` tables, or before adding a new assistant tool. The UI side is in [`CLIENT_WEB/context/ai-assistant.md`](../../CLIENT_WEB/context/ai-assistant.md).

---

## Mental model

```
CLIENT_WEB drawer / /ai-assistant ──POST /api/v1/ai/chat (SSE)──▶ routes/ai.js
  correlation id → auth → validateBranch → ensure tables → resolveUserAccess → frozen ctx
  → branch settings (enabled + decrypted API key) → rate limit (branch limits)
        │
        ▼
  ai/orchestrator.js  ── the branch's model (ai/providers/*) decides which tools to call
        │  tool_use
        ▼
  MCP Client ⇄ InMemoryTransport ⇄ per-request McpServer   (ai/mcp/createMcpForRequest.js)
        │  only tools this user may use are registered
        ▼
  ai/mcp/runTool.js → zod validation → permission re-check → timeout → handler
        ▼
  ai/tools/*.js → existing helpers / parameterised SQL, always `branch_id = ctx.branch_id`
        ▼
  { data → model (truncated JSON) , blocks → UI (tables / KPIs / charts) }  → saved in ai_messages
```

**Three rules that must never be broken:**

1. **Identity only comes from `ctx`.** `ctx = { username, branch_id, isAdmin, permissions, today }` is built from the `auth` + `validateBranch` middleware and `helpers/permissionCheck.js`, then frozen. **No tool input schema may contain `branch_id`, the acting username or a permission flag.** Schemas are `.strict()`, so unknown keys are rejected.
2. **Read-only.** There are no write tools. Adding one needs a separate design with explicit user confirmation.
3. **Numbers come from rows.** Tables, KPIs and charts are built in tool handlers from query results (`ai/blocks.js`). The model's text is never parsed into data, and the system prompt forbids invented values.

---

## Files

| File | Role |
|------|------|
| `routes/ai.js` | API (status, settings, chat, conversations), SSE streaming, persistence, audit. `createAiRouter({...})` takes injectable deps for tests |
| `ai/settings.js` | Branch switch and rate limits in `branch_ai_settings`. Moves a legacy single key into a connection on first read |
| `ai/connections.js` | AI connections in `branch_ai_connections`: CRUD, priority order, health status, decrypted runtime list (max 10 per branch) |
| `ai/failover.js` | `runWithFailover()` tries enabled connections in priority order, with an in-memory cooldown for failed ones |
| `ai/safety.js` | Safety guard. `checkQuestion()` runs before any provider call, `checkAnswer()` before a reply is shown or saved, and `createSafetyLimiter()` pauses repeat offenders |
| `ai/schema.js` | DDL for all AI tables; `ensureAiTables()` creates them on first use (no manual migration) |
| `helpers/secretBox.js` | AES-256-GCM encrypt/decrypt + mask for stored credentials |
| `ai/orchestrator.js` | Tool loop and limits; `buildHistory()` for bounded follow-up context |
| `ai/mcp/createMcpForRequest.js` | Per-request `McpServer` + `Client` (MCP TypeScript SDK v2, `@modelcontextprotocol/server` / `client`) |
| `ai/mcp/runTool.js` | Validation, permission re-check, timeout, truncation, audit hook; blocks travel in `_meta["ooms/blocks"]` |
| `ai/tools/*.js` | Tools (staff, tasks, attendance, finance, reports) + `ask_clarification` |
| `ai/tools/common.js` | Shared zod fields, `ToolError`, self-scope helpers, due-date buckets |
| `ai/blocks.js` | Block builders and the block contract |
| `ai/dateRange.js` | Natural periods → explicit dates (IST, Monday weeks, FY from 1 April) |
| `ai/prompts/system.js` | Fixed system prompt (anti-fabrication, prompt-injection rules) |
| `ai/config.js` | Fixed limits (`AI_LIMITS`) — no environment variables |
| `ai/redact.js` | Hides internal IDs (task_id, usernames, party ids) from users. `runTool` reports every ID in a result (`_meta["ooms/ids"]`). The orchestrator removes them, plus `usr_…` / `APP…_BRN…` patterns, from the reply text and visible block strings, and drops ID columns. Link keys stay hidden in rows for `href`. Saved conversations are sanitized again when read. The model still gets IDs, as tool arguments only |
| `ai/providers/catalog.js` | Supported providers: label, suggested models, default model, loose key pattern, key help link. Sent to the settings page (without patterns) |
| `ai/providers/{anthropic,openai,gemini,deepseek}.js` | One adapter per vendor. `getProviderForBranch()` (`index.js`) builds and caches one per branch from its settings |
| `ai/providers/translate.js` | Shared helpers for the non-Anthropic adapters (vendor replay block, tool-argument parsing, history folding) |
| `ai/store.js` | `ai_conversations` / `ai_messages` / `ai_tool_calls`, always filtered by `branch_id` + `username` |
| `ai/deps.js` | Production deps injected into tools (`pool`, `GET_BALANCE`, `collectLedgerStatement`) |
| `ai/log.js` | Redacted JSON logs (hashed user, no message text, no results, no secrets) |
| `helpers/permissionCheck.js` | `resolveUserAccess()`, the same rules as the route-level `checkUserPermission` copies |
| `middleware/aiRateLimit.js` | Per branch + user: per minute, per day, one in-flight request |
| `database/migrations/20261020_ai_assistant.sql` | Same DDL as `ai/schema.js`, for reference / manual runs |

`helpers/transactionParty.js` now also exports `getOppositePartySnippet` (moved unchanged from `routes/transactions.js`) so the ledger statement tool produces the same "particulars" as the ledger page.

---

## Tools and permissions

"Self-scope" means a user who is not an admin and lacks `staff_view_manage` only sees tasks assigned to them (via `task_staffs`) and their own attendance. **This is stricter than the existing `/task/list` and `/attendance/day-list` routes, which are branch-wide.**

| Tool | Gate | Source / rule |
|------|------|---------------|
| `search_staff` | none (contact details need `staff_view_manage`) | `branch_mapping` + latest `profile`, active and accepted |
| `search_tasks` | self-scope | `/task/list` filters plus due filters; counts are computed over **all** matches, then one page of rows |
| `get_staff_tasks` | self-scope | `task_staffs` ⨝ `tasks` (as in `report.js /staff-tasks`) |
| `get_task_details` | self-scope | `tasks` + assigned staff + last 5 `task_status` rows |
| `task_summary` | `task_summary_view` + self-scope | Status counts, OD/DT/D7/FT for active tasks, per-staff completion |
| `attendance_report` | self-scope | `attendance` with no row → `not_marked` (counted as absent), as in `buildListState` |
| `leave_summary` | self-scope | `attendance.status IN ('leave','half day')`; there is no leave-balance table |
| `search_parties` | `finance_balance_view` or `finance_report` | clients / CAs / staff / banks / capitals; mobile is masked |
| `get_party_balance` | `finance_balance_view` | Existence check in the branch, then `GET_BALANCE` |
| `get_outstanding_balances` | `finance_balance_view` | `helpers/clientBalanceSql.js` (debtor / creditor) |
| `get_ledger_statement` | `finance_report` | `collectLedgerStatement`; at most 200 rows, totals cover all rows |
| `expense_report` | `finance_report` | `expense_entries` excluding discount and payslip rows (same as `/expense/list`) |
| `sales_report` | `finance_report` or `sales_overview_view` | `SUM(sale_items.total)` by `DATE(invoice.create_date)` (same as `/report/sales-top-summary`) |
| `dashboard_summary` | `dashboard_statistics_view` | Each KPI is also gated by its own permission |
| `ask_clarification` | none | Ends the turn and shows option chips |

Branch admins (`branch_mapping.type = 'admin'`) hold every permission. A key only counts while it is active in `permission_option`.

**Business rules in use:**
- **Overdue:** status is `in process`, `pending from client` or `pending from department`, and `due_date` is before today (IST).
- **Balance:** total debit (party is party2) minus total credit (party is party1), with the opening balance included. Positive = Dr. For a client, Dr means the client owes the office.

---

## Configuration (per branch, no env)

Branch admins configure the assistant in **CLIENT_WEB → Settings → AI Assistant** (`/settings/ai-assistant`).

**`branch_ai_settings`** (one row per branch): `enabled` (`'1'` shows Ask AI and allows chat; needs at least one switched-on connection) and `rate_per_min` / `rate_per_day` (per-user limits). Its `provider` / `model` / `effort` / `api_key_*` columns are legacy. On first read they're copied into a connection (`migrateLegacyKey`), then the key columns are cleared.

**`branch_ai_connections`** (up to 10 per branch, several per provider allowed):

| Column | Meaning |
|--------|---------|
| `connection_id` | UUID used by the API |
| `label` | Optional admin-given name |
| `provider` / `model` / `effort` | `anthropic`, `openai`, `gemini` or `deepseek`; any model ID (the catalog only suggests models); `low` / `medium` / `high` |
| `api_key_enc` / `api_key_hint` | AES-256-GCM encrypted key (`helpers/secretBox.js`), never returned by any API; masked `••••AbCd` |
| `enabled` | `'0'` = never used |
| `priority` | 1 = asked first. Set by `PUT /connections/order` |
| `last_status` / `last_checked_at` / `last_used_at` | Health shown in Settings: `ok` or a `ProviderError` code (`BILLING`, `INVALID_KEY` …) |

- **Failover.** Each question goes to the first enabled connection. On a provider-side error it is re-run from the start on the next one, because each vendor keeps its own message state. That covers `BILLING`, `INVALID_KEY`, `MODEL_UNAVAILABLE`, `RATE_LIMITED`, `UNAVAILABLE`, `TIMEOUT` and `BAD_REQUEST`.
  - At most 3 connections are tried per question, within the 90 s request deadline.
  - A failed connection cools down in memory, per process: 15 min for credit, key or model problems, 1 min for others. It's tried after the healthy ones.
  - The user sees one status line, "Switching to a backup AI service". If every attempt fails, they get `AI_ALL_CONNECTIONS_FAILED`.
  - `ai_messages.model` records `provider:model` of the connection that answered.
- **Admin only.** Only branch admins (`branch_mapping.type = 'admin'`) can read or change settings and connections (`requireBranchAdmin`). A connection's provider can only change together with a new key. Deleting a connection removes its row and key.
- **Encryption key.** Derived from `APP_ENCRYPTION_KEY`, falling back to `SMTP_ENCRYPTION_KEY` and then a built-in default, like the SMTP credentials. Set it once in production. Changing it makes stored keys unreadable: those connections are skipped and admins must replace the keys.
- **Missing rows.** Branches without a settings row are disabled.

## Safety guard (`ai/safety.js`)

The guard is deterministic, needs no AI call, and runs on **every** question and answer.

1. **Question check.** Before any provider call, the question is normalised: NFKC, zero-width and control characters stripped, spaced-out letters joined. Blocked categories:
   - `prompt_injection`, e.g. "ignore previous instructions", "developer mode" or role tags;
   - `code_request`: write or run SQL or code, raw SQL, injection payloads;
   - `system_probe`: prompt or instructions, tools, source code or algorithms, database schema, keys, env or servers, which AI model or vendor;
   - `unsafe_content`: hacking, data theft, other branches' data.

   A blocked question gets a fixed reply, saved with status `refusal`, and no provider is called. Real office words such as "internal audit", "HSN code", client "queries" and "ledger statement" are allowed (`tests/ai.safety.test.js`).
2. **Answer check**, in `runChat`. If the reply contains any of the following, it's replaced with a safe sentence (tool-built tables stay):
   - SQL or code, or file paths;
   - internal table or tool names;
   - secrets;
   - system-prompt fingerprints;
   - vendor or infrastructure names.

   Words that appear in the office's own data **values** are allowed; JSON keys are not. For example, a client called "Gemini Traders" is fine. Clarification options get the same check.
3. **Repeat offenders.** 5 blocked questions within 10 minutes pause that user for 15 minutes (`AI_SAFETY_PAUSED`).
4. **System prompt.** A "Confidentiality" section tells the model to treat the system and vendor as private, whatever the phrasing.
5. **Logging.** Only the category is logged (`safety_block`, `safety_answer_blocked`), never the question text.

## Providers

The orchestrator speaks the Anthropic Messages shape (`content` blocks, `tool_use` / `tool_result`). Each adapter converts to and from its vendor API and returns `{stop_reason, content, usage}` in that shape. Tools, blocks, history and UI don't depend on the provider.

| Provider | SDK / API | Effort maps to | Reasoning replayed between tool rounds |
|---|---|---|---|
| `anthropic` | `@anthropic-ai/sdk`, Messages (beta: server-side fallback) | `output_config.effort` | Native content blocks |
| `openai` | `openai`, Responses API, `store: false` | `reasoning.effort` | Encrypted reasoning items (`include: ["reasoning.encrypted_content"]`) |
| `gemini` | `@google/genai`, `generateContent` | `thinkingConfig.thinkingLevel` (Gemini 3+ only) | Model `Content` verbatim, so function-call thought signatures survive |
| `deepseek` | `openai` with `baseURL: https://api.deepseek.com`, Chat Completions | `reasoning_effort` | Raw assistant message including `reasoning_content` |

- **Vendor block.** Non-Anthropic adapters add `{type: "vendor", provider, data}` to each assistant turn with the raw output. Only the same adapter reads it back, and it's never stored.
- **DeepSeek history.** With tools, DeepSeek requires `reasoning_content` on every earlier assistant turn, and stored history has none. Earlier turns are therefore folded into the current question as a text transcript (`foldHistoryIntoQuestion`).
- **Errors.** Every SDK error maps to a `ProviderError` code. Quota or unpaid-balance errors (OpenAI/DeepSeek 429 quota, 402) map to `INVALID_KEY`, so users are told to contact their admin. Gemini's 400 "API key not valid" also maps to `INVALID_KEY`.
- **Adding a provider.** Add a catalog entry and an adapter, then register it in `FACTORIES` (`ai/providers/index.js`). Cover it in `tests/ai.providers.test.js` by injecting a fake `client`.

## Limits (fixed in `ai/config.js`)

| Limit | Value |
|-------|-------|
| Model iterations per question (the last one forces a text answer) | 6 |
| Tool calls per question; duplicate calls are served from a per-request cache | 12 |
| Tool timeout / provider call / whole request | 8 s / 45 s / 90 s |
| Tool result sent to the model (lists halved until it fits, with a `_truncated` marker) | 12,000 chars |
| History: last N messages, char cap | 12 messages / 40,000 chars |
| Rows: `limit` ≤ 50, `page` ≤ 20, block tables ≤ 200 rows | — |
| Date span: attendance 186 days, other tools 366 days | — |
| Rate limit (from branch settings, held in memory per pm2 process) | default 6 per minute, 200 per day, 1 in flight |

---

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/ai/status` | `{enabled, configured, can_manage}` for the current branch (any member) |
| GET | `/api/v1/ai/settings` | Admin: `{settings, connections (keys masked), providers, efforts, limits}` |
| PUT | `/api/v1/ai/settings` | Admin: `{enabled, rate_per_min, rate_per_day}`. Enabling needs an active connection (`NO_ACTIVE_CONNECTION`) |
| POST | `/api/v1/ai/settings/test` | Admin: `{provider, api_key, model, effort?}`. Tests an unsaved key: a model lookup, then one 16-token request, so missing credit is detected |
| POST | `/api/v1/ai/connections` | Admin: `{label?, provider, model, effort?, api_key, enabled?}`. Added last in the order. Key format checked per provider; max 10 (`CONNECTION_LIMIT`) |
| PATCH | `/api/v1/ai/connections/:id` | Admin: any of `{label, model, effort, enabled, api_key, provider}`. Provider change requires `api_key` |
| DELETE | `/api/v1/ai/connections/:id` | Admin: removes the row and its key |
| PUT | `/api/v1/ai/connections/order` | Admin: `{ids}`, which must list every connection of the branch exactly once |
| POST | `/api/v1/ai/connections/:id/test` | Admin: tests the saved key and model, and records `last_status` |
| POST | `/api/v1/ai/chat` | Body `{ message (1-2000), conversation_id?, stream? }`. SSE events: `meta`, `status`, `block`, `text`, `done`, `error`. `stream:false` returns JSON |
| GET | `/api/v1/ai/conversations?page=` | The caller's conversations in this branch |
| GET | `/api/v1/ai/conversations/:id` | 404 unless it belongs to the caller and branch |
| DELETE | `/api/v1/ai/conversations/:id` | Soft delete |

Errors returned to users are friendly codes only: `AI_DISABLED`, `AI_NOT_CONFIGURED`, `AI_NO_CREDIT`, `AI_INVALID_KEY`, `AI_MODEL_UNAVAILABLE`, `AI_ALL_CONNECTIONS_FAILED`, `AI_SAFETY_PAUSED`, `AI_RATE_LIMITED`, `AI_PROVIDER_BUSY`, `AI_PROVIDER_UNAVAILABLE`, `AI_TIMEOUT`, `AI_ADMIN_ONLY`. SQL, stack traces and provider messages are never sent to the client or the model.

---

## Setup

1. Deploy the code and run `npm install`. This adds `@anthropic-ai/sdk`, `openai` (also used for DeepSeek), `@google/genai`, `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and `zod`. Restart with `pm2 restart <app>`.
2. Recommended once per server: set `APP_ENCRYPTION_KEY=<long random string>` in `SERVER/.env` before any admin saves a key.
3. A branch admin opens **Settings → AI Assistant**, clicks **Add connection** and fills in provider, key, model and effort. They click **Test connection**, then save. Optionally they add more connections as backups and drag them into order. Finally they switch the assistant on.
4. The tables are created automatically on first use. `npm run migrate:ai-assistant` does the same thing explicitly; don't use `npm run migrate`, which replays every `.sql` file.

**Proxy:** if nginx or another proxy sits in front of the API, disable buffering for `/api/v1/ai/chat` (`proxy_buffering off; proxy_read_timeout 120s;`). The server already sends `X-Accel-Buffering: no`.

**Rollback per branch:** switch the assistant off in Settings, or switch individual connections off.

**Tests:** run `npm test` (`node --test "tests/*.test.js"`). The AI tests use fakes only, with no database, network or model calls.

---

## Adding a tool

1. Add a definition in `ai/tools/<area>.js` with this shape: `{ name, description, input: z.object({...}).strict(), allowed(ctx), handler(ctx, args, deps) → { data, blocks } }`.
2. Scope every query with `branch_id = ?` taken from `ctx.branch_id`. Apply self-scope where personal data is involved. Use explicit columns and parameters only.
3. Reuse existing helpers for business rules (balances, statuses, report sums). Never write a second, conflicting calculation.
4. Throw `ToolError("NOT_FOUND" | "DENIED" | "INVALID", message)` for expected failures.
5. Register the tool in `ai/tools/index.js`, add a status label in `orchestrator.js`, and add tests in `tests/ai.tools.test.js`.

---

## Known gaps

- Tasks have no priority column.
- There are no leave types or balances.
- Salary and payroll are not exposed to the assistant.
- Downloads are CSV only, built on the client from the rows shown. There is no PDF or Excel export from chat; use the existing ledger PDF from the client profile.
- The rate limit is held in memory per process.
- Usage and cost per branch are not tracked beyond token counts in `ai_messages`.
- Server-side gaps not fixed here: existing finance routes don't check `finance_*` permissions on the server, and `report.js` checks `card_*` keys that don't match `permissionDefaults.js`.
