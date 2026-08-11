# B2 media proxy — Server context

> **Purpose:** Tag this doc when returning file/image URLs from APIs, or when wiring new media that lives in Backblaze B2. Use the **server media proxy** so clients never talk to B2 directly.

> **Why:** Some networks (dev machines, restricted office networks) cannot reach Backblaze. The live OOMS API (`https://server.ooms.in`) can. Responses should therefore expose **proxy URLs** hosted on that reachable server.

---

## Mental model

```
DB stores filename (or relative object key)
        ↓
API builds URL with helpers/mediaUrl.js
        ↓
Client requests GET https://server.ooms.in/proxy/media/...
        ↓
routes/mediaProxy.js → downloadB2Object (helpers/b2Storage.js)
        ↓
Stream file to client
```

**Do not** return direct B2 signed download URLs (`…backblazeb2.com/file/…?Authorization=…`) in normal API list/detail responses.

---

## Mount + path shape

| Item | Value |
|------|--------|
| Express mount | `app.use("/proxy/media", mediaProxyHandler)` in `server.js` |
| Handler | `routes/mediaProxy.js` |
| Example request | `GET /proxy/media/profile/document/it/abc.pdf` |
| B2 object key | `media/profile/document/it/abc.pdf` |

Resolution order inside the proxy:

1. B2 (`downloadB2Object`)
2. Local `SERVER/media/…` disk
3. Legacy hosted fallback (`MEDIA_FALLBACK_ORIGIN`, default `https://server.ooms.in`)

---

## Env (important for local API)

| Variable | Role |
|----------|------|
| `BASE_DOMAIN` | Default host used when building absolute URLs |
| `MEDIA_PROXY_BASE_DOMAIN` | Optional override **only** for `/proxy/media` URL host |

For local development when B2 is unreachable from your network:

```env
BASE_DOMAIN=https://server.ooms.in
# or keep API on localhost and force media URLs to live:
# BASE_DOMAIN=http://localhost:8877
# MEDIA_PROXY_BASE_DOMAIN=https://server.ooms.in
```

`getMediaProxyBaseDomain()` in `helpers/mediaUrl.js` resolves:

`MEDIA_PROXY_BASE_DOMAIN` → `BASE_DOMAIN` → `https://server.ooms.in`

So document/image links in JSON point at the live proxy even if you later set `BASE_DOMAIN` back to localhost for other absolute links.

---

## Helpers to use (do not reinvent)

File: `helpers/mediaUrl.js`

| Helper | Use for |
|--------|---------|
| `buildMediaProxyUrl(...segments)` | Generic: `buildMediaProxyUrl("profile", "document", "it", filename)` |
| `buildProfileDocumentUrl(categoryFolder, filename)` | Profile docs under `media/profile/document/{category}/` |
| `buildProfileImageUrl(filename)` | Profile images |
| `buildBranchLogoUrl(filename)` / `buildBranchSignUrl(filename)` | Branch logo / sign |
| `resolveProfileDocumentUrl` / `resolveProfileImageUrl` | Sync drop-in replacements for old async signed-URL helpers |
| `getMediaProxyBaseDomain()` | Read the configured proxy host |

File: `helpers/b2Storage.js`

| Helper | Use for |
|--------|---------|
| `getProfileDocumentAccessUrl(category, filename)` | **Returns proxy URL** (via `buildProfileDocumentUrl`) for API responses |
| `downloadAndUploadProfileDocument` / `uploadProfileDocumentBuffer` | Upload into B2 |
| `downloadB2Object` | Used by the proxy only (or server-side downloads) |

Example response field:

```js
file: el.file ? await getProfileDocumentAccessUrl("it", el.file) : null
// -> https://server.ooms.in/proxy/media/profile/document/it/<filename>
```

Or without await:

```js
import { buildProfileDocumentUrl } from "../helpers/mediaUrl.js";

file: buildProfileDocumentUrl("general", el.file)
```

Category folders in use today include: `it`, `gst`, `mca`, `general`, `task`, `sharable`, plus OneChatting template media categories.

---

## Checklist when adding a new media field

1. Store **filename only** in DB (not a full B2 URL).
2. On upload, put the object under `media/...` via `b2Storage` helpers.
3. On list/detail responses, return `buildMediaProxyUrl(...)` / `buildProfileDocumentUrl(...)` / `getProfileDocumentAccessUrl(...)`.
4. Confirm the URL host is reachable from the client network (usually `https://server.ooms.in`).
5. Do **not** expose raw B2 keys or signed B2 URLs to the browser unless there is a special external integration that requires them.
6. Tag this file (`SERVER/context/proxy.md`) in the agent chat when implementing or reviewing media URL changes.

---

## Related files

| Path | Role |
|------|------|
| `routes/mediaProxy.js` | Proxy HTTP handler |
| `helpers/mediaUrl.js` | URL builders + path parsing |
| `helpers/b2Storage.js` | B2 auth, upload, download |
| `helpers/Config.js` | `BASE_DOMAIN` |
| `server.js` | Mounts `/proxy/media` |
