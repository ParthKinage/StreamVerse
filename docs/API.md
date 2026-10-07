# API reference

Base path: `/api/v1` (exceptions: `/playback/...` and the ops endpoints, noted below). Responses are JSON. The web app and the API share one origin (Vite proxy in development, a reverse
proxy in production), which is what makes the httpOnly cookies work.

**Conventions**

- **Money** is always a non-negative integer string of wei (`"600000000000000000"` = 0.6 STRM). Floats never appear.
- **Auth:** `Authorization: Bearer <accessToken>` (15 min JWT). The refresh token is the signed httpOnly cookie
  `refresh_token`, rotated on every `/auth/refresh`; re-using an old refresh token revokes the whole family.
- **Errors** share one shape: `{ "error": { "code": "...", "message": "...", "details": ... } }`.
- **Pagination:** `cursor` (opaque) and `limit` (default 20, max 50); responses carry `nextCursor` (`null` at the end).
- **Rate limits:** per IP (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX` for auth routes) and per user on watch routes; exceeded
  limits return `429 RATE_LIMITED`.

## Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body, query or params failed validation (`details` lists fields) |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `PLAYBACK_TOKEN_INVALID` | Missing or bad token, wrong login, expired playback cookie |
| 402 | `INSUFFICIENT_BALANCE` | Not enough available STRM to start or continue |
| 403 | `FORBIDDEN`, `NOT_CREATOR`, `PLAYBACK_TOKEN_INVALID` | Wrong role or another user's session |
| 404 | `NOT_FOUND`, `VIDEO_NOT_AVAILABLE`, `MEDIA_MISSING` | Unknown or unpublished resource; video files gone from storage |
| 409 | `CONFLICT`, `EMAIL_TAKEN`, `USERNAME_TAKEN`, `WALLET_ALREADY_LINKED`, `WALLET_IN_USE`, `WALLET_HAS_BALANCE`, `SEQUENCE_CONFLICT`, `SESSION_NOT_ACTIVE`, `WALLET_NOT_LINKED` | State conflicts |
| 400/413/415 | `UPLOAD_TOO_LARGE`, `UPLOAD_INVALID`, `UPLOAD_NOT_FOUND` | Upload rejected or not arrived yet |
| 422 | `INVALID_SIGNATURE`, `NONCE_EXPIRED` | Wallet link proof failed |
| 429 | `RATE_LIMITED`, `SEGMENT_BUDGET_EXCEEDED` | Throttled |
| 500/503 | `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE` | Server or dependency failure |

## Auth

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/register` `{email, username, password}` | none | 201 `{accessToken, user}`; sets the refresh cookie |
| `POST /auth/login` `{email, password}` | none | 200 `{accessToken, user}` |
| `POST /auth/refresh` | cookie | 200 `{accessToken, user}`; rotates the cookie |
| `POST /auth/logout` | cookie | 204; revokes the refresh family |
| `GET /auth/me` | bearer | Current user |
| `PATCH /users/me`, `POST /users/me/password` | bearer | Profile and password change |

## Wallet

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /config` | none | Chain id, RPC and explorer URLs, contract addresses, heartbeat interval, welcome bonus, withdraw delay, fee bps, max price, access hours, categories |
| `POST /wallet/nonce` `{address}` | bearer | Returns the message to sign (contains nonce, user id, chain id). Nonce lives 5 minutes in Redis and is single use |
| `POST /wallet/link` `{address, signature}` | bearer | Verifies `personal_sign`; first link queues the welcome bonus |
| `DELETE /wallet/link` | bearer | `409 WALLET_HAS_BALANCE` while escrow or unsettled charges exist |
| `GET /wallet/summary` | bearer | `escrowWei`, `pendingWithdrawalWei`, `withdrawUnlockAt`, `unsettledChargesWei`, `availableWei`, `creatorEarningsWei` |
| `GET /wallet/transactions` | bearer | Cursor list: deposits, withdrawals, settlements (`Watched: <title>`), rewards (`Welcome bonus`), earnings claims |

Deposits, withdrawals and claims are on-chain transactions sent by the user's wallet; the API learns about them
through the chain indexer (a few seconds). `availableWei = escrow - pending withdrawal - unsettled charges - open session charge`.

## Bank wallet (`PAYMENTS_MODE=bank`)

`GET /config` returns `paymentsMode`, `currencyCode`, `currencySymbol`, `bankAccounts`, `minTopUpWei`, `maxTopUpWei`.
All amounts are wei strings (18 decimals). All endpoints need a bearer token.

| Method and path | Body | Result |
|---|---|---|
| `POST /bank/topup` | `{accountId, amountWei}` | 201 `{summary}`. 402 `BANK_DECLINED` for the declined account, 400 `INVALID_AMOUNT` outside the limits, 400 `UNKNOWN_BANK_ACCOUNT`. |
| `POST /bank/withdraw` | `{accountId, amountWei}` | `{summary}`. 402 `INSUFFICIENT_BALANCE` if more than the available balance. |
| `POST /bank/cashout` | `{accountId}` | Creators only. `{amountWei, summary}` pays all claimable earnings out. |
| `GET /creator/received?cursor=` | | `{items:[{id, amountWei, videoTitle, viewerName, watchedSeconds, receivedAt}], nextCursor}` |

`GET /wallet/summary` and `GET /wallet/transactions` work as before (transactions come from the ledger and settlements).

## Catalog and social

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /videos?q=&category=&creatorId=&sort=newest\|popular\|trending` | optional | Published, processed videos |
| `GET /videos/:id`, `GET /videos/:id/thumbnail` | optional / none | |
| `GET /categories` | none | `[{name, count}]` |
| `GET /creators/:id` | none | Public channel profile |
| `GET /recommendations?videoId=&limit=` | optional | `{items, source: "ai" \| "fallback"}`; falls back to trending when the AI service is slow or down (800 ms budget, circuit breaker) |
| `POST /videos/:id/like`, `POST /videos/:id/watchlist`, `GET /me/watchlist` | bearer | Toggles |

## Creator

All require a bearer token; everything except `POST /creator/profile` also requires a channel (`403 NOT_CREATOR`).

| Endpoint | Notes |
|---|---|
| `POST /creator/profile` `{channelName, bio?}` | Any user can become a creator |
| `POST /creator/uploads` `{fileName, contentType, sizeBytes}` | Object storage only (`/config` says `uploadMode: "direct"`; otherwise `409 NOT_AVAILABLE_IN_THIS_MODE`). 201 `{uploadToken, uploadUrl, method: "PUT", headers, expiresAt}`. PUT the file to `uploadUrl` with exactly `headers`. `413 UPLOAD_TOO_LARGE` above `MAX_UPLOAD_MB`, `400 UPLOAD_INVALID` for other extensions |
| `POST /creator/uploads/complete` `{uploadToken, title, description?, category?, tags?, priceWei?}` | 201 video (`PENDING`, transcode queued). Same video with 200 when repeated. `400 UPLOAD_NOT_FOUND` before the file has arrived, `413` if larger than announced, `400 UPLOAD_INVALID` for an expired or invalid token or a file without a video stream (the object is deleted), `403` for another user's token |
| `POST /creator/videos` | `multipart/form-data`: `file`, `title`, `description`, `category`, `tags` (comma separated), `priceWei` (price of the whole video, 0 to 500). Magic bytes are checked, size capped by `MAX_UPLOAD_MB`. Enqueues transcoding |
| `GET /creator/videos` | Includes `processingStatus` (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`), `transcodeProgress`, `failureReason` |
| `PATCH /creator/videos/:id` | Title, description, category, tags, price |
| `POST /creator/videos/:id/publish`, `/unpublish`, `/retry` | Publishing needs `COMPLETED`; retry re-queues a failed transcode |
| `DELETE /creator/videos/:id` | Archives |
| `GET /creator/analytics` | Views, watch seconds, earnings by video and by day |
| `GET /creator/earnings` | `claimableWei`, `lifetimeEarnedWei`, `pendingSettlementWei`. Claiming is the on-chain `claimEarnings()` |

## Watching and billing

| Endpoint | Notes |
|---|---|
| `POST /videos/:id/purchase` | Buys `ACCESS_HOURS` (default 48) of access to a paid video. Returns `{videoId, priceWei, accessUntil, alreadyUnlocked, availableWei}`. Charges nothing if access is already active. `402 INSUFFICIENT_BALANCE` (details: `requiredWei`, `availableWei`), `402 WALLET_NOT_LINKED` (chain mode), `400` for free or own videos. The price becomes a `PaymentSettlement` (no session), reserved from the balance immediately |
| `POST /watch/sessions` `{videoId}` | 201 `{sessionId, endToken, manifestUrl, heartbeatIntervalSec, resumePositionSec, availableWei, free, accessUntil}`. Paid videos need an active purchase, otherwise `402 PURCHASE_REQUIRED` (details: `priceWei`). Free videos and a creator's own videos need none. Ends any other open session of the user. Sets the playback cookie |
| `POST /watch/sessions/:id/heartbeat` `{sequence, playbackTime, state}` | `state` is `playing`, `paused` or `buffering`. Returns `{sequence, verifiedSeconds, chargedWei (always 0), availableWei, accessUntil, action}` with `action` = `continue` or `stop` (`reason: ACCESS_EXPIRED`; the cookie is not renewed) |
| `POST /watch/sessions/:id/end` | Bearer, or `endToken` in the body (for `sendBeacon`). Counts a view when verified time is at least 30 s. Watching is not charged; the payment happened at purchase |
| `GET /me/history`, `GET /me/continue-watching` | |
| `GET /playback/:sessionId/*` | HLS manifests and segments, mounted at the origin root (not under `/api/v1`) so relative playlist URIs keep working. Needs the `pbt` cookie for exactly this session. With object storage only playlists are served here: each segment line is a signed bucket URL that expires `SEGMENT_URL_SLACK_SEC` after the segment's start time, and segment paths return 404. `404 MEDIA_MISSING` when the video's files are no longer in storage |

Heartbeat rules (server clock only; clients never send durations or amounts):

1. `sequence == last` returns the stored response (idempotent retry); anything other than `last + 1` is `409 SEQUENCE_CONFLICT`.
2. Credited seconds = `playing ? min(now - lastHeartbeat, interval + 2 s) : 0`, floored to whole seconds.
3. Watching is not metered for money. Verified seconds only drive view counts, resume position and the segment budget. A heartbeat after the purchase window ended returns `stop` / `ACCESS_EXPIRED`.
4. Local storage: the playback route serves media only while `servedSeconds <= 1.5 * verifiedSeconds + 120`; otherwise
   `429 SEGMENT_BUDGET_EXCEEDED` and the player retries after the next heartbeat. Object storage: see
   `docs/DECISIONS.md` D-SEGMENT-BUDGET.
5. A session with no heartbeat for 45 s is ended by the reaper like an explicit end.

## Admin (role `ADMIN`)

| Endpoint | Notes |
|---|---|
| `GET /admin/users`, `GET /admin/videos` | Paged lists |
| `POST /admin/videos/:id/unpublish` | Moderation |
| `GET /admin/settlements` | Includes `status`, `attempts`, `lastError`, `txHash` |
| `POST /admin/settlements/:id/retry` | Re-queues a `FAILED` settlement |
| `GET /admin/health` | Overall status (`ok`, `degraded`, `down`), Postgres, Redis, chain and AI probes, plus settlement counts by status, queue job counts, AI breaker state, indexer cursor, relayer address and gas balance |

## Operations

| Endpoint | Notes |
|---|---|
| `GET /health` | Liveness (always 200 while the process runs) |
| `GET /ready` | Postgres and Redis must be reachable (else 503); chain and AI status are reported but do not block |

Both are served at the root (`/health`, `/ready`) and under `/api/v1`.
