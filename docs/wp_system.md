# OOMS System WhatsApp — Context & Integration Guide

Use this document to continue work on the **OOMS System** WhatsApp channel. Share it in future chats so the assistant has full project context without re-explaining the architecture.

---

## Overview

The platform supports **three WhatsApp channels** per branch (`branch_list.whatsapp_channel`):

| Channel value | Description                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `disabled`    | No WhatsApp notifications                                                                                                 |
| `ooms system` | Built-in OOMS templates; backend sends via OneChatting with **static env tokens** (user does not connect developer token) |
| `ooms web`    | Unofficial WhatsApp Web automation (maintained by us); branch session + static template content                           |
| `onechatting` | Official OneChatting integration; user connects their own developer + user tokens                                         |

**OOMS System** is our in-build notification channel:

- Templates are defined centrally in JSON by admins/developers.
- Branches **pick** which template variant to use per activity **type** (e.g. `task create`).
- Sending uses OneChatting APIs under the hood, but users never configure OneChatting credentials.

---

## Architecture

```mermaid
flowchart TB
    subgraph config [Configuration]
        A[branch_list.whatsapp_channel = ooms system]
        B[wp_system_template_mapping per branch + type]
        C[utils/WP_SYSTEM_TEMPLATES.json]
        D[.env OneChatting tokens]
    end

    subgraph api [Admin / Frontend API]
        E[GET /wp-system/templates]
        F[PUT /wp-system/template-map/set]
    end

    subgraph events [Automatic events]
        G[Task create]
        H[Task complete]
        I[Payment receive]
    end

    subgraph send [Backend send]
        J[helpers/whatsappNotification.js]
        K[services/wpSystemWhatsappSendService.js]
        L[OneChatting template-list - project token]
        M[OneChatting send-template - system token]
    end

    A --> J
    B --> K
    C --> K
    D --> K
    E --> B
    F --> B
    G --> J
    H --> J
    I --> J
    J --> K
    K --> L
    K --> M
```

---

## Key files

| File                                      | Role                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `utils/WP_SYSTEM_TEMPLATES.json`          | Master list of system template definitions (type, template_name, Meta-style components, preview examples) |
| `services/wpSystemTemplateService.js`     | Load JSON, list by type, get/set/unset branch mappings in DB                                              |
| `services/wpSystemWhatsappSendService.js` | Resolve `template_id`, build `component`, send via OneChatting                                            |
| `helpers/whatsappNotification.js`         | Channel router; builds variables; calls send on task/payment events                                       |
| `routes/whatsapp.js`                      | HTTP endpoints for channel + OOMS system template mapping                                                 |
| `media/wp_system/`                        | Header images referenced in templates (`{BASE_DOMAIN}/media/wp_system/...`)                               |
| `server.js`                               | Serves static files at `/media/wp_system`                                                                 |
| `.env`                                    | `ONECHATTING_SYSTEM_DEVELOPER_TOKEN`, `ONECHATTING_PROJECT_DEVELOPER_TOKEN`                               |

**Route mount:** `routes/index.js` → `/api/v1/broadcast/whatsapp/*`

---

## Database

### `branch_list.whatsapp_channel`

```sql
enum('disabled','ooms system','ooms web','onechatting')
```

### `wp_system_template_mapping`

| Column                                                 | Description                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `id`                                                   | Auto increment PK                                            |
| `branch_id`                                            | Branch                                                       |
| `map_id`                                               | e.g. `WSTM_<hex>`                                            |
| `type`                                                 | Activity type string, e.g. `task create`, `payment reminder` |
| `template_name`                                        | Variant from JSON, e.g. `task_create`                        |
| `status`                                               | `1` = active, `0` = unset                                    |
| `create_by`, `modify_by`, `create_date`, `modify_date` | Audit                                                        |

Type matching is **case-insensitive** in queries (`LOWER(TRIM(type))`). On set, the canonical `type` from JSON is stored.

---

## Template JSON (`WP_SYSTEM_TEMPLATES.json`)

Each entry:

```json
{
  "type": "task create",
  "template_name": "task_create",
  "template": {
    "name": "task_create",
    "category": "UTILITY",
    "language": "en",
    "components": ["... HEADER IMAGE, BODY with {{1}} placeholders ..."]
  },
  "example": ["... preview for frontend ..."]
}
```

**Body variables** are defined in `template.components[BODY].example.body_text[0]` as `{{name}}`, `{{branch_name}}`, etc. Order maps to WhatsApp `{{1}}`, `{{2}}`, …

**Header images** use `{BASE_DOMAIN}/media/wp_system/<file>` — replaced at send time with `BASE_DOMAIN` from env/Config.

### Currently defined templates

| type               | template_name      | Image                    |
| ------------------ | ------------------ | ------------------------ |
| `payment reminder` | `payment_reminder` | `payment-reminder-1.jpg` |
| `task create`      | `task_create`      | `task-create-1.png`      |

### Not yet in JSON (but referenced elsewhere)

- `task complete` — hook exists in `whatsappNotification.js` but no JSON entry yet
- `payment receive` — used by transactions flow via generic channel router
- Other types in `utils/WhatsAppTemplates.js` (`birthday wish`, `payment`, etc.)

To add a new type: add entry to `WP_SYSTEM_TEMPLATES.json`, ensure matching template is **APPROVED** in OneChatting portal under the same `template_name`, then branches map it via API.

---

## Environment variables

```env
ONECHATTING_SYSTEM_DEVELOPER_TOKEN=<user developer token>   # SEND messages
ONECHATTING_PROJECT_DEVELOPER_TOKEN=<project developer token> # LIST templates
ONECHATTING_BASE_URL=https://server.onechatting.com         # optional override
BASE_DOMAIN=https://server.ooms.in                             # image URLs in templates
```

### Critical token split (verified working)

| Operation             | Token                       | OneChatting endpoint                    |
| --------------------- | --------------------------- | --------------------------------------- |
| Resolve `template_id` | **Project** developer token | `GET /developer/template/template-list` |
| Send template message | **System** developer token  | `POST /developer/message/send-template` |

Do **not** use the system token for template-list — it returns `Invalid token`.

After `.env` changes: `pm2 restart 0 --update-env`

---

## API endpoints

**Base:** `/api/v1/broadcast/whatsapp`

**Headers:** `token`, `username`, `branch` (or `branch_id` query fallback)

### Channel (prerequisite)

| Method | Path       | Body                           | Notes                                  |
| ------ | ---------- | ------------------------------ | -------------------------------------- |
| `GET`  | `/channel` | —                              | Returns `{ channel }`                  |
| `PUT`  | `/channel` | `{ "channel": "ooms system" }` | Must be `ooms system` for this feature |

### OOMS system templates

| Method | Path                                    | Body / query                                                |
| ------ | --------------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/wp-system/templates?type=task create` | Lists variants + `active_template_name`                     |
| `GET`  | `/wp-system/template-map-list`          | All JSON types with branch mapping status                   |
| `PUT`  | `/wp-system/template-map/set`           | `{ "type": "task create", "template_name": "task_create" }` |
| `PUT`  | `/wp-system/template-map/unset`         | `{ "type": "task create" }`                                 |

User does **not** submit `component` JSON (unlike OneChatting channel). Backend builds it from JSON + variables.

---

## Send flow (`sendOomsSystemTemplateMessage`)

1. Validate `branch_id`, `systemType`, `recipientNumber`
2. Load **system** + **project** tokens from env
3. `getActiveMapping(branch_id, systemType)` → `template_name`
4. `findSystemTemplate(type, template_name)` from JSON
5. `resolveTemplateId(projectToken, template_name)` — paginated APPROVED list
6. Build `component` array (header image + body text parameters)
7. Substitute variables (`{{name}}`, `{{branch_name}}`, …); `{{branch_name}}` from `branch_list.name` if not provided
8. POST send with **system** token:

```json
POST /developer/message/send-template
Headers: { "token": "<ONECHATTING_SYSTEM_DEVELOPER_TOKEN>" }
Body: {
  "number": "91XXXXXXXXXX",
  "template_id": "<from template-list>",
  "component": [
    { "type": "header", "parameters": [{ "type": "image", "image": { "link": "https://..." } }] },
    { "type": "body", "parameters": [{ "type": "text", "text": "..." }, ...] }
  ]
}
```

Returns `{ ok, reason?, template_id?, response? }` — failures are silent to end users (no throw unless outer catch in notify helpers).

---

## Automatic event hooks

Implemented in `helpers/whatsappNotification.js`. Fired asynchronously via `notify*` helpers (fire-and-forget).

| Event           | Helper                         | systemType / type string | Called from                                                             |
| --------------- | ------------------------------ | ------------------------ | ----------------------------------------------------------------------- |
| Task create     | `notifyTaskCreatedWhatsapp`    | `task create`            | `routes/task.js` (multi + legacy create), `helpers/taskCreateHelper.js` |
| Task complete   | `notifyTaskCompletedWhatsapp`  | `task complete`          | `routes/task.js`                                                        |
| Payment receive | `notifyPaymentReceiveWhatsapp` | `payment receive`        | `routes/transactions.js`                                                |

**Task create** uses an explicit `ooms system` branch in `sendTaskCreatedWhatsapp` before falling back to other channels.

**Requirements for send:**

- `whatsapp_channel === "ooms system"`
- Active mapping for that `type` in `wp_system_template_mapping`
- Client mobile on profile
- Both env tokens set
- Template approved in OneChatting with matching `template_name`

### Task create variables (built in `buildTaskCreateVariables`)

`{{name}}`, `{{mobile}}`, `{{email}}`, `{{firm_name}}`, `{{service_name}}`, `{{due_date}}`, `{{created_by}}`, `{{created_date}}`, `{{fees}}`, `{{payment_link}}`, `{{balance}}`, plus `{{branch_name}}` at send time.

### Task complete variables (`buildTaskCompleteVariables`)

`{{name}}`, `{{service_name}}`, `{{fees}}`, `{{completed_by}}`, `{{completed_date}}`, `{{branch_name}}`, etc.

---

## Differences vs other channels

|                           | OOMS System                | OneChatting                          | WhatsApp Web            |
| ------------------------- | -------------------------- | ------------------------------------ | ----------------------- |
| User token setup          | No                         | Yes                                  | Session/QR              |
| User provides `component` | No                         | Yes                                  | Custom content in DB    |
| Template source           | `WP_SYSTEM_TEMPLATES.json` | User's OneChatting account           | Branch static templates |
| Mapping API body          | `{ type, template_name }`  | `{ name, template_name, component }` | Different service       |

---

## Frontend integration (summary)

1. `GET /channel` → show channel selector
2. If `ooms system`: show `GET /wp-system/template-map-list`
3. Per type: `GET /wp-system/templates?type=...` → preview cards → `PUT /wp-system/template-map/set`
4. No send button needed for task create/complete — automatic after mapping

Preview from API response:

- Image: `templates[n].example[0].example.header_handle[0]`
- Body sample: `templates[n].example[1].example.body_text[0]`
- Variables: `templates[n].available_variables`

---

## Implementation status (as of 2026-06-27)

### Done

- OOMS system channel enum + PUT/GET `/channel`
- Template list / map list / set / unset APIs
- `wp_system_template_mapping` CRUD service
- Send service with dual-token split (project list + system send)
- Task create auto-send on `ooms system` channel
- Generic `sendWhatsappByChannel` OOMS system path for other events
- Static media served at `/media/wp_system`
- Debug logging removed after verification

### Pending / future work

- Add `task complete` entry to `WP_SYSTEM_TEMPLATES.json` + test mapping
- Wire `payment reminder` to a scheduled/manual trigger if not already
- Add more template variants per type in JSON
- Payment receive / other types on OOMS system channel (router supports it; need JSON + mappings)
- Optional: admin API to hot-reload templates without deploy

---

## Adding a new template type (checklist)

1. Create Meta-approved template in OneChatting portal; note exact `template_name`
2. Add entry to `utils/WP_SYSTEM_TEMPLATES.json` (match `template_name`, define `type`, components, variables)
3. Add header image to `media/wp_system/` if needed
4. Expose in frontend via existing list/set endpoints (types auto-discovered from JSON)
5. Call `sendOomsSystemTemplateMessage({ branch_id, systemType: "<type>", recipientNumber, variables })` from the relevant event hook, or rely on `sendWhatsappByChannel` if `systemTemplateName` matches the type string
6. Restart PM2 if only code changed; JSON is read at runtime (cached in memory until process restart)

---

## Troubleshooting

| Symptom                          | Likely cause                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------- |
| No message on task create        | Channel not `ooms system`, no mapping, no client mobile, or template not mapped |
| `Invalid token` on template list | Using system token instead of project token for list                            |
| `template_id_not_found`          | `template_name` in JSON ≠ OneChatting approved template name                    |
| Message fails on send            | System token invalid, or `component` / image URL not accessible publicly        |
| Wrong channel path               | Branch still on `onechatting` — check `GET /channel`                            |

---

## Related constants (`helpers/whatsappNotification.js`)

```js
TASK_CREATE_TEMPLATE_NAME = "task create";
TASK_COMPLETE_TEMPLATE_NAME = "task complete";
PAYMENT_RECEIVE_TEMPLATE_NAME = "payment receive";
WHATSAPP_CHANNEL_OOMS_SYSTEM = "ooms system";
```

Channel value from DB is normalized: `trim().toLowerCase()` before compare.
