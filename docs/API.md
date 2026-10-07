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
| `POST /creator/uploads/complete` `{uploadToken, title, description?, category?, tags?, ratePerMinuteWei?}` | 201 video (`PENDING`, transcode queued). Same video with 200 when repeated. `400 UPLOAD_NOT_FOUND` before the file has arrived, `413` if larger than announced, `400 UPLOAD_INVALID` for an expired or invalid token or a file without a video stream (the object is deleted), `403` for another user's token |
| `POST /creator/videos` | `multipart/form-data`: `file`, `title`, `description`, `category`, `tags` (comma separated), `ratePerMinuteWei` (0 to 100 per minute; 0 = free). Magic bytes are checked, size capped by `MAX_UPLOAD_MB`. Enqueues transcoding |
| `GET /creator/videos` | Includes `processingStatus` (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`), `transcodeProgress`, `failureReason` |
| `PATCH /creator/videos/:id` | Title, description, category, tags, `ratePerMinuteWei` |
| `POST /creator/videos/:id/publish`, `/unpublish`, `/retry` | Publishing needs `COMPLETED`; retry re-queues a failed transcode |
| `DELETE /creator/videos/:id` | Archives |
| `GET /creator/analytics` | Views, watch seconds, earnings by video and by day |
| `GET /creator/earnings` | `claimableWei`, `lifetimeEarnedWei`, `pendingSettlementWei`. Claiming is the on-chain `claimEarnings()` |

## Live streaming

A live stream owns a video (`videoId`): viewers watch it with the normal `POST /watch/sessions` and `/playback`, and
pay per piece exactly as for videos. Creator endpoints need a bearer token and a channel.

| Endpoint | Notes |
|---|---|
| `GET /live` | Streams on air now, as videos with `live: {streamId, status, startedAt, viewers}`, busiest first. Public; cacheable for 10 s when anonymous |
| `POST /creator/live` `{title, description?, category?, tags?, ratePerMinuteWei?, saveAsVod? (true)}` | 201 stream `{id, videoId, status: CREATED, ...}` |
| `GET /creator/live`, `GET /creator/live/:id` | Own streams with `viewers`, `peakViewers`, `durationSeconds`, `earnedWei` (creator's share so far), `initSeq`, `nextIndex` |
| `POST /creator/live/:id/start` `{codecs, width, height, bandwidth}` | Before sending, and after every reconnect: `CREATED -> STARTING`, or a new connection number (`initSeq`) if the stream already sent pieces. Returns where to carry on (`initSeq`, `nextIndex`). `409 INVALID_TRANSITION` once ended |
| `POST /creator/live/:id/upload-urls` `{names}` | Up to 30 of `init_<n>.mp4`, `seg_<6 digits>.m4s`, `thumbnail.jpg`. Returns `{items: [{name, url, method: PUT, headers, viaApi}], expiresAt}`: signed storage URLs (10 minutes), or API paths on local storage (`viaApi: true`, send with the bearer token) |
| `PUT /creator/live/:id/files/:name` | Local storage only; raw body up to 8 MB |
| `POST /creator/live/:id/segments` `{index, initSeq, durationMs}` | Adds an uploaded piece to the playlist (the first one makes the stream `LIVE`). Repeating the same piece is accepted. `409 LIVE_SEGMENT_INVALID` for a piece out of order, from an older connection, or running ahead of the clock; `409 LIVE_NOT_ACTIVE` after the end |
| `POST /creator/live/:id/thumbnail` | After uploading `thumbnail.jpg` |
| `POST /creator/live/:id/end` | `ENDING -> ENDED`; the recording becomes a published video, or is deleted when `saveAsVod` is false. A stream that never started is cancelled (`FAILED`) |
| `POST /admin/live/:id/end` | Admin: ends any stream (`ENDED_BY_ADMIN`) |

While a stream is on air, `/playback/:session/master.m3u8` and `src/index.m3u8` are built from the database (no end
tag); `src/init_<n>.mp4` is free; `src/seg_<n>.m4s` is charged like any piece.

## Watching and billing

| Endpoint | Notes |
|---|---|
| `POST /videos/:id/purchase` | **Retired**: `410 NOT_AVAILABLE_IN_THIS_MODE`. Viewers pay per second while watching. Former behaviour: | Buys `ACCESS_HOURS` (default 48) of access to a paid video. Returns `{videoId, priceWei, accessUntil, alreadyUnlocked, availableWei}`. Charges nothing if access is already active. `402 INSUFFICIENT_BALANCE` (details: `requiredWei`, `availableWei`), `402 WALLET_NOT_LINKED` (chain mode), `400` for free or own videos. The price becomes a `PaymentSettlement` (no session), reserved from the balance immediately |
| `POST /watch/sessions` `{videoId}` | 201 `{sessionId, endToken, manifestUrl, heartbeatIntervalSec, resumePositionSec, availableWei, free, ratePerMinuteWei, paidSeconds, accessUntil: null}`. Needs about a minute of balance (or the rest of the video) unless every remaining second is already paid: otherwise `402 INSUFFICIENT_BALANCE` (details: `requiredWei`, `availableWei`). `402 WALLET_NOT_LINKED` / `404 VIDEO_NOT_AVAILABLE` when a side cannot pay or be paid (linked-wallet chain mode). Free videos and a creator's own videos cost nothing. Ends any other open session of the user. Sets the playback cookie |
| `POST /watch/sessions/:id/heartbeat` `{sequence, playbackTime, state}` | `state` is `playing`, `paused` or `buffering`. Returns `{sequence, verifiedSeconds, chargedWei (this session so far), availableWei, secondsRemaining (new video the balance still covers), paidSeconds (of this video, all sessions), action: continue}`. Heartbeats never charge |
| `POST /watch/sessions/:id/end` | Bearer, or `endToken` in the body (for `sendBeacon`). Counts a view when verified time is at least 30 s. The session's charges become one settlement |
| `GET /me/history`, `GET /me/continue-watching` | |
| `GET /playback/:sessionId/*` | HLS playlists and 4-second pieces (`<rendition>/seg_<n>.ts`), mounted at the origin root so relative playlist URIs keep working. Needs the `pbt` cookie for exactly this session. **Each piece is charged the first time this viewer is sent it** (rate x duration; free again forever, in any rendition), then served (local) or redirected (`302`) to a signed bucket URL valid 120 s (s3). `402 INSUFFICIENT_BALANCE` when the balance cannot cover a new piece. `404 MEDIA_MISSING` when the video's files are no longer in storage |

Heartbeat rules (server clock only; clients never send durations or amounts):

1. `sequence == last` returns the stored response (idempotent retry); anything other than `last + 1` is `409 SEQUENCE_CONFLICT`.
2. Credited seconds = `playing ? min(now - lastHeartbeat, interval + 2 s) : 0`, floored to whole seconds.
3. Money is charged per piece of video sent (see `/playback`), never from heartbeats. Verified seconds drive view counts and the resume position.
4. There is no segment budget any more: fetching ahead costs the viewer money (the player buffers at most 10 s).
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
