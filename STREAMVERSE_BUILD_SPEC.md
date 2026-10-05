# StreamVerse (Tesor_gp) — Completion Spec for Claude Code

Repository: `https://github.com/Achira621/Tesor_gp`
Product: **StreamVerse**, a Web3 pay-as-you-watch video streaming platform on Polygon.
Audit basis: `main` at commit `f1f3047`.

This file is the single source of truth for finishing the platform. Put it in the repo root and work through it phase by phase.

---

## 0. Instructions to Claude Code

1. **Read first:** every file in `.agents/rules/` (`followedrule.md`, `architecturerules.md`, `creativeboundries.md`, `dependencies.md`) and `TEAM_WORKFLOW.md`. Those rules stay in force. Create a root `CLAUDE.md` that points to them and to this spec so they load in every session.
2. **Approval:** `architecturerules.md` requires explicit approval before architectural changes. The decisions in section 3 and the schema changes in section 6 are approved by the project owner through this document. Anything architectural that is *not* listed here still needs approval: stop and ask.
3. **Work in phases (sections 5 to 12), in order.** Each phase ends with acceptance checks. Run them. Do not start the next phase while any check fails.
4. **No guessing.** Never invent package versions, contract addresses, ABIs or credentials. Install packages with `npm install <name> --workspace=<ws>` and let the lockfile record the version. Contract addresses come only from the deploy script output. If something is truly undecidable, write it to `docs/DECISIONS.md` as `UNKNOWN`, apply the default from section 15, and continue.
5. **Every feature needs:** implementation, tests, error handling, a defined failure behaviour, and a doc entry (`docs/API.md` for endpoints, `docs/DECISIONS.md` for choices).
6. **Git:** create `feature/complete-platform` from `main`. One commit (or small group of commits) per phase, conventional commit messages, pull request into `develop`. Never push to `main` or `develop` directly.
7. **Platform:** the team develops on Windows as well as Linux/macOS. Use `path.join`, never shell-specific commands in npm scripts, spawn FFmpeg with an argument array (no shell string), and prefer pure-JS packages over native addons (for example `bcryptjs`).

---

## 1. Audit: what exists today

| Area | State |
|---|---|
| `apps/web` | One file, `App.tsx`: a static mock with four tabs, two hard-coded videos, a fake wallet toggle (`0x71C...3A9`, balance `250`), a placeholder where the player should be. No router, no API calls, no wallet code. |
| `apps/api` | `package.json` and `tsconfig.json` only. No source. |
| `packages/shared`, `packages/blockchain` | Manifests only. No source. |
| `packages/database` | `prisma/schema.prisma` with 7 models. No `src/`, no migrations, no seed. |
| `workers/video-processor`, `ai` | Manifests only. No source. |
| `contracts` | `StreamCoin.sol` (hand-written ERC-20) and a `hardhat.config.js`. Hardhat is not installed. No PaymentRouter, no tests, no deploy script. |
| Tooling | CI workflow, `.env.example`, Prettier. No ESLint, no test runner, empty README. |

### Defects to fix (all confirmed by running the repo)

| # | Defect | Effect |
|---|---|---|
| D1 | `.gitignore` contains `*.ts` (intended for HLS segments). | **Every TypeScript source file is ignored by git.** This is almost certainly why the packages have no committed source. Highest priority. |
| D2 | `npm run build` fails with `TS18003: No inputs were found` in `packages/shared`, `blockchain`, `database`, `apps/api`, the worker and `ai`. | CI is red; nothing can build. |
| D3 | Root `dev` script is `npm run dev --workspaces`, which runs workspaces one after another. `apps/api` dev is `tsc -w`, which never exits. | The web app never starts, and the API never actually runs (it only compiles). |
| D4 | `apps/web` has no `vite.config.ts` and no `vite-env.d.ts`. | The React plugin is installed but unused; the app serves on 5173, while the docs and `.env.example` say 3000; no API proxy. |
| D5 | Root `tsconfig.json` uses `references`, but no project sets `composite: true`. | `tsc -b` fails. |
| D6 | `contracts/package.json` build is an `echo`; Hardhat and OpenZeppelin are not dependencies. | Contract cannot be compiled, tested or deployed. |
| D7 | `StreamCoin.sol` is a hand-rolled ERC-20 (no zero-address checks, no standard library). | Unaudited token logic for a payments project. |
| D8 | Money columns in Prisma are `Float` (`ratePerMinuteSTRM`, `amountSTRM`, `totalEarnings`, ...). | Rounding errors in billing. |
| D9 | Schema gaps: `PaymentSettlement.creatorId` / `videoId` have no relations; no indexes on foreign keys; `WatchHeartbeat` has no unique `(sessionId, sequence)`; nothing models deposits, refresh tokens, or chain events. | Replay, duplicate-billing and integrity risks. |
| D10 | CI runs `npm ci \|\| npm install`, has no Postgres/Redis/FFmpeg, and no lint or typecheck step. | Lockfile drift is hidden; tests cannot run. |
| D11 | `lint` script exists but no linter is configured; test scripts are `echo` placeholders. | No quality gate. |
| D12 | UI text promises "up to 4GB" uploads and shows fabricated numbers ("42 mins", "14.2 STRM"). | Misleading until wired to real data. |

---

## 2. Product definition

### Roles
- **Viewer** (`USER`): browses, deposits STRM, watches, pays per verified second.
- **Creator** (`CREATOR`): everything a viewer can do, plus uploads, pricing, analytics, claiming earnings.
- **Admin** (`ADMIN`): moderation and operations.

### Core journey (must work end to end without bugs)
1. Register with email and password, log in.
2. Connect MetaMask and link the wallet by signing a nonce.
3. Receive a welcome STRM bonus credited straight into the on-chain escrow (no gas needed to start watching).
4. Browse or search, open a video, press play.
5. Watch: a live meter shows verified time, cost so far and remaining balance. Low balance triggers a top-up prompt; zero balance pauses playback cleanly.
6. Top up: approve + deposit STRM into the PaymentRouter.
7. Session ends: the cost is settled on-chain in a batch; the wallet page shows the transaction with an explorer link.
8. Creator: become a creator, upload a video, watch transcoding progress, set price, publish, see analytics, claim earnings on-chain.

### Feature tiers
- **Must:** auth, wallet linking, catalog + search, upload + transcode + HLS playback, playback authorization, heartbeat billing, escrow deposit/withdraw, batch settlement, creator earnings claim, welcome reward, recommendations with fallback, creator studio, wallet page, watch history, resume position.
- **Should:** watchlist, likes, creator channel page, creator analytics charts, admin panel (moderation, settlement queue, health).
- **Could (only after everything above passes section 13):** comments, subscriptions, on-chain tips.

---

## 3. Locked architecture and approved decisions

Unchanged from the repo rules: npm-workspaces monorepo, TypeScript, React + Vite, Express API, PostgreSQL + Prisma, Redis, FFmpeg + HLS, Polygon Amoy (chain id 80002), StreamCoin (STRM, 18 decimals).

Approved by this document:

| # | Decision |
|---|---|
| A1 | **Payment model: prepaid escrow + batched settlement.** Viewers deposit STRM into a `PaymentRouter` contract. Watch time is metered off-chain by the server. A relayer settles finished sessions on-chain in batches. No per-second or per-heartbeat transactions. |
| A2 | **Timelocked withdrawals.** Viewers withdraw unspent escrow in two steps (request, then execute after a delay) so pending off-chain charges can be settled first. |
| A3 | **OpenZeppelin** for all contracts. `StreamCoin` is re-implemented on OZ `ERC20` + `ERC20Permit`, keeping name, symbol, decimals and the `constructor(uint256 initialSupply)` semantics. |
| A4 | **Local Hardhat network (chain id 31337)** for development and automated tests. Amoy remains the demo/deployment network. The active chain comes from `CHAIN_ID`. |
| A5 | **Money is never a float.** Database: `Decimal(38,18)`. API: decimal strings of wei. Arithmetic: `bigint`. |
| A6 | **Auth:** email + password, short-lived JWT access token (in memory on the client), rotating refresh token in an `httpOnly` cookie, stored hashed. Wallet ownership is proven by signature. |
| A7 | **Playback authorization:** HMAC-signed token (TTL 30 s) in an `httpOnly` cookie scoped to `/playback/<sessionId>/`, renewed by each heartbeat. Works for hls.js and Safari native HLS. Web and API share one origin (Vite proxy in dev, reverse proxy in production). |
| A8 | **Queues:** BullMQ on Redis for `transcode` and `settlement`. |
| A9 | **Module boundaries:** the worker and the AI service have no database access. The worker reports through job progress/results; the API passes candidate data to the AI service in the request. Only `apps/api` uses `@tesor_gp/database`. |
| A10 | **Storage:** a `StorageProvider` interface with the `local` provider implemented. If `STORAGE_PROVIDER` is `s3` or `ipfs`, fail at startup with a clear "not implemented" error. No half-built providers. |
| A11 | **Frontend libraries:** `react-router-dom`, `@tanstack/react-query`, `hls.js`, `ethers` (v6). Styling continues with the existing CSS variables in `index.css`, moved into CSS modules. No UI framework. |
| A12 | **Testing:** Vitest (unit/integration), Supertest (API), Hardhat (contracts), Playwright (end to end). ESLint with typescript-eslint. |

---

## 4. Target layout

```text
apps/api/src/
  index.ts  app.ts  config/env.ts
  modules/{auth,users,catalog,creator,media,playback,watch,wallet,settlement,rewards,recommendations,admin}/
     <module>.routes.ts  <module>.service.ts  <module>.schemas.ts  index.ts (public interface)  __tests__/
  infra/{redis.ts,queues.ts,storage/,logger.ts,events.ts}
  middleware/{auth.ts,error.ts,rateLimit.ts,validate.ts}
apps/web/src/
  main.tsx  App.tsx  routes.tsx
  api/ (typed client)  auth/  wallet/  player/  pages/  components/  hooks/  styles/
packages/shared/src/      types, zod schemas, constants, money utils, domain event names
packages/database/src/    Prisma client export, seed
packages/blockchain/src/  ABIs, addresses, typed read/write adapter
contracts/{contracts,test,scripts,deployments}/
workers/video-processor/src/
ai/src/
e2e/                      Playwright
docs/{API.md,DECISIONS.md,ARCHITECTURE.md,DEMO.md}
docker-compose.yml        Postgres + Redis for local dev
```

Modules talk to each other only through each module's `index.ts`. A module never queries another module's tables directly.

---

## 5. Phase 0 — Repair the foundation

1. **D1:** in `.gitignore`, delete `*.ts`, `*.mp4`, `*.m3u8`. The existing `uploads/`, `hls-output/`, `temp/` entries already cover media. Add `coverage/`, `playwright-report/`, `test-results/`. Keep `contracts/deployments/31337.json` ignored and `80002.json` committed.
2. **D2/D5:** add `src/index.ts` to every workspace; set `composite: true` where the root `tsconfig.json` references a project, or remove the references and build through npm scripts. `npm run build` must pass.
3. **D3:** root `dev` uses `concurrently` to run: shared packages in watch mode, API with `tsx watch`, worker with `tsx watch`, AI service with `tsx watch`, web with Vite. Add `dev:chain` (Hardhat node) and `dev:infra` (`docker compose up`).
4. **D4:** add `apps/web/vite.config.ts` (React plugin, port 3000, proxy `/api` and `/playback` to `http://localhost:4000`) and `vite-env.d.ts`.
5. **D11:** ESLint + typescript-eslint at the root, Vitest in each TS workspace, real `lint`, `typecheck` and `test` scripts.
6. **D10:** CI uses `npm ci` only; adds Postgres and Redis service containers and installs FFmpeg; runs lint, typecheck, test, build, contract tests.
7. `docker-compose.yml` with Postgres 16 and Redis 7.
8. `config/env.ts` in the API: validate all environment variables with zod at startup and exit with a readable message listing what is missing.
9. Write the README: what the project is, prerequisites, a five-command quick start.

**Acceptance:** fresh clone, then `npm ci && npm run build && npm run lint && npm test` exits 0. `git status` shows new `.ts` files as tracked. `npm run dev` starts every service and `GET http://localhost:4000/health` returns 200.

---

## 6. Phase 1 — Shared package and database

### `packages/shared`
- Money helpers on `bigint`: `parseSTRM`, `formatSTRM`, `costForSeconds(seconds, ratePerMinuteWei) = seconds * rate / 60n` (floor).
- Zod schemas for every request and response; inferred types are used by both API and web.
- Constants: heartbeat interval, token TTL, limits. Domain event names. Error code enum.

### Schema changes (approved)
- Every STRM column: `Float` becomes `Decimal @db.Decimal(38,18)`.
- `PaymentSettlement`: add relations for `creatorId` and `videoId`; add `settlementKey String @unique` (the bytes32 id used on-chain), `attempts Int`, `lastError String?`, `settledAt DateTime?`.
- `WatchHeartbeat`: `@@unique([sessionId, sequence])`, plus `creditedSeconds Int`.
- `WatchSession`: add `lastSequence Int`, `lastPlaybackTime Float`, `chargedSTRM Decimal`, `endedAt DateTime?`, `endReason String?`.
- `Video`: add `tags String[]`, `failureReason String?`, `transcodeProgress Int`.
- `TokenReward`: add `@@unique([userId, reason])` for one-time rewards.
- Indexes on every foreign key and on `Video(isPublished, processingStatus, createdAt)`, `WatchSession(userId, status)`.
- New models:
  - `RefreshToken` (id, userId, tokenHash unique, expiresAt, revokedAt, createdAt).
  - `EscrowAccount` (userId unique, onChainBalance, pendingWithdrawal, updatedAtBlock).
  - `ChainEvent` (txHash + logIndex unique, name, blockNumber, payload Json, processedAt) for idempotent indexing.
  - `ChainCursor` (chainId + contract unique, lastProcessedBlock).
  - `WatchlistItem`, `VideoLike` (userId + videoId unique) — tier "Should".

Create the migration, a `seed.ts` (admin, two creators, three viewers, six videos generated from FFmpeg `testsrc` so no copyrighted media is needed), and export a singleton Prisma client.

**Acceptance:** `prisma migrate dev` applies cleanly on an empty database; `npm run seed` is idempotent; money helper unit tests cover rounding and large values.

---

## 7. Phase 2 — Smart contracts

Install Hardhat, the Hardhat toolbox and `@openzeppelin/contracts` in `contracts/`. Replace the echo scripts with real `build`, `test`, `deploy:local`, `deploy:amoy`.

### `StreamCoin.sol`
OZ `ERC20` + `ERC20Permit`. Constructor mints `initialSupply * 10**18` to the deployer.

### `PaymentRouter.sol`
OZ `AccessControl`, `ReentrancyGuard`, `Pausable`, `SafeERC20`.

| Function | Access | Behaviour |
|---|---|---|
| `deposit(amount)` | anyone | Pull STRM, credit `escrow[msg.sender]`. |
| `depositFor(viewer, amount)` | anyone | Pull STRM from caller, credit `escrow[viewer]`. Used for rewards. |
| `depositWithPermit(amount, deadline, v, r, s)` | anyone | One-transaction top-up. |
| `requestWithdraw(amount)` | viewer | Move amount from `escrow` to `pendingWithdrawal`, record `unlockAt = now + withdrawDelay`. One open request per viewer. |
| `cancelWithdraw()` | viewer | Return pending amount to escrow. |
| `executeWithdraw()` | viewer | After `unlockAt`, transfer the remaining pending amount. |
| `settleBatch(Settlement[] items)` | `SETTLER_ROLE` | Each item: `{bytes32 id, address viewer, address creator, uint256 amount}`. Revert the item's id if already settled (`settled[id]`). Debit `escrow[viewer]` first, then `pendingWithdrawal[viewer]` if escrow is short. Fee = `amount * feeBps / 10000`. Credit `creatorEarnings[creator]` and `platformEarnings`. Max batch size constant. |
| `claimEarnings()` | creator | Transfer `creatorEarnings[msg.sender]`. |
| `withdrawPlatformFees(to)` | admin | Transfer platform earnings. |
| `setFeeBps(bps)` | admin | Capped at a hard maximum (3000). |
| `pause` / `unpause` | admin | Pauses deposits and settlement; withdrawals stay open. |

Events for every state change, indexed by viewer/creator. Custom errors instead of revert strings.

### Tests (Hardhat)
Deposit, permit deposit, withdraw timelock, cancel, settlement math and fee split, double-settlement rejection, settlement drawing from pending withdrawal, insufficient escrow, role checks, pause behaviour, batch limit, reentrancy attempt, fee cap. Target 100% line coverage for `PaymentRouter`.

### Deploy script
Deploys both contracts, grants `SETTLER_ROLE` to the relayer, funds the relayer's reward pool, writes `contracts/deployments/<chainId>.json` (addresses + deployment block) and prints the env lines.

**Acceptance:** `npm test --workspace=@tesor_gp/contracts` passes; `deploy:local` works against `npm run dev:chain`.

---

## 8. Phase 3 — Blockchain SDK (`packages/blockchain`)

- Exports ABIs (copied from Hardhat artifacts by a build step), addresses loaded from the deployments JSON with env override, and a typed adapter over ethers v6.
- Read: `getEscrow(viewer)`, `getCreatorEarnings(creator)`, `getTokenBalance`, `getLogs(fromBlock, toBlock)`.
- Write (relayer): `settleBatch`, `depositFor`. A single in-process mutex serialises relayer transactions so nonces never collide.
- All calls have timeouts, bounded retries with backoff, and map failures to typed errors (`RpcUnavailable`, `Reverted`, `InsufficientGas`).
- The relayer private key is read only on the server. It must never be imported by `apps/web`. Add an ESLint `no-restricted-imports` rule to enforce that.

**Acceptance:** integration tests run against a local Hardhat node started by the test setup.

---

## 9. Phase 4 — API (`apps/api`)

Express, JSON under `/api/v1`, HLS under `/playback`. Middleware: `helmet`, CORS allowlist from `WEB_BASE_URL`, request id, structured logging (pino), zod validation, Redis-backed rate limiting, a central error handler returning `{ error: { code, message, details? } }`. Never leak stack traces.

### Endpoints

| Module | Endpoints |
|---|---|
| auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; `GET /auth/me` |
| wallet link | `POST /wallet/nonce`, `POST /wallet/link` (verify `personal_sign` over a message containing nonce, user id, chain id; nonce in Redis, 5 min TTL, single use), `DELETE /wallet/link` (blocked while escrow or unsettled charges exist) |
| catalog | `GET /videos` (q, category, sort, cursor), `GET /videos/:id`, `GET /categories`, `GET /creators/:id` |
| creator | `POST /creator/profile`, `POST /creator/videos` (multipart upload), `GET /creator/videos`, `PATCH /creator/videos/:id`, `POST /creator/videos/:id/publish`, `/unpublish`, `/retry`, `DELETE /creator/videos/:id` (archive), `GET /creator/analytics`, `GET /creator/earnings` |
| watch | `POST /watch/sessions`, `POST /watch/sessions/:id/heartbeat`, `POST /watch/sessions/:id/end`, `GET /me/history`, `GET /me/continue-watching` |
| playback | `GET /playback/:sessionId/*` (manifests, segments) |
| wallet | `GET /wallet/summary`, `GET /wallet/transactions` (cursor), `GET /config` (chain id, contract addresses, explorer URL, rates) |
| recs | `GET /recommendations?videoId=&limit=` |
| social (Should) | watchlist and like toggles |
| admin (Should) | users, videos, unpublish, settlement queue, retry failed, health |
| ops | `GET /health` (liveness), `GET /ready` (Postgres, Redis; chain and AI reported but non-blocking) |

### Uploads
Multer to disk under `UPLOAD_DIR`, random file names, size cap `MAX_UPLOAD_MB`, validated with `ffprobe` (must contain a video stream; reject otherwise and delete the file). Creates `Video(PENDING)` and enqueues a `transcode` job. The API listens to BullMQ queue events and is the only writer of `processingStatus`, `transcodeProgress`, `durationSeconds`, `hlsManifestPath`, `thumbnailPath`, `failureReason`.

### Watch-time billing (the core algorithm)

Constants: `HEARTBEAT_INTERVAL = 10 s`, `GRACE = 2 s`, `PLAYBACK_TOKEN_TTL = 30 s`, `SESSION_TIMEOUT = 45 s`.

**Available balance** = `EscrowAccount.onChainBalance` − sum of unsettled `PaymentSettlement.amountSTRM` − charges of the user's open session.

**Start session**
1. Video must be published and `COMPLETED`.
2. User must have a linked wallet and available balance ≥ cost of 60 s (skip both for free videos and for a creator watching their own video).
3. End any other open session of this user (one concurrent stream).
4. Create the session, set the playback cookie, return `sessionId`, manifest URL, heartbeat interval, resume position.

**Heartbeat** `{ sequence, playbackTime, state }`, inside one DB transaction with a row lock on the session:
1. `sequence == lastSequence`: return the previous response (idempotent retry). `sequence != lastSequence + 1`: 409.
2. `wallDelta = now − lastHeartbeatAt` using the **server** clock.
3. `credited = state == "playing" ? min(wallDelta, HEARTBEAT_INTERVAL + GRACE) : 0`, floored to whole seconds.
4. `verifiedDurationSeconds += credited`; `chargedSTRM = costForSeconds(verified, rate)`.
5. If available balance < cost of the next interval: mark `PAUSED`, do not renew the cookie, respond `action: "stop"`. If less than 2 minutes of balance remain: `action: "low_balance"`. Otherwise `action: "continue"` and renew the cookie.
6. Response: verified seconds, charge so far, available balance, action.

**Segment budget (anti-cheat):** the playback route counts media seconds served per session in Redis. Serve a segment only while `servedSeconds ≤ 1.5 × verifiedSeconds + 120`. Beyond that return 429; the player retries after the next heartbeat. This bounds what a client can download without paying, including clients that falsely report "paused".

**End session** (explicit end, `stop`, or the reaper finding no heartbeat for `SESSION_TIMEOUT`): mark `COMPLETED`, create one `PaymentSettlement(PENDING)` if the charge is above zero, enqueue settlement, count a view once per session if verified time ≥ 30 s. A paused-for-balance session resumes with a new session after top-up.

The client never sends durations, balances or amounts that the server trusts.

### Chain indexer
A polling loop reads PaymentRouter logs from `ChainCursor`, waits `CONFIRMATIONS` blocks, stores each log in `ChainEvent` (unique on tx hash + log index), and applies it to `EscrowAccount`. On start it backfills from the deployment block. On RPC failure it logs, backs off and retries; playback continues on the last known balance.

### Settlement worker
BullMQ job, concurrency 1. Collects up to `SETTLE_BATCH_SIZE` pending settlements, calls `settleBatch`, stores `txHash`, waits for confirmations, marks `SETTLED` and the session `SETTLED`. On failure: increment attempts, record the error, retry with exponential backoff; after `MAX_ATTEMPTS` mark `FAILED` and surface it in the admin panel. Because ids are unique on-chain, retries can never double-charge. Before sending, check which ids are already settled on-chain and reconcile.

### Rewards
On first successful wallet link, create `TokenReward(reason: "WELCOME")` and have the relayer call `depositFor(user, WELCOME_BONUS)`. Unique `(userId, reason)` plus one reward per wallet address prevents farming. If the chain is unavailable, the reward job stays queued.

### Recommendations
Call the AI service with a 800 ms timeout and a circuit breaker (open after 5 consecutive failures, half-open after 30 s). On any failure return trending (views in the last 7 days, then newest). The response includes `source: "ai" | "fallback"`.

**Acceptance:** Supertest suites for every module. Specific required tests: replayed heartbeat, skipped sequence, heartbeat flood (many in one second credits at most the wall-clock time), paused state credits zero, balance exhaustion stops the session, expired playback cookie gives 401, another user's session cookie gives 403, segment budget returns 429, settlement retry after simulated RPC failure produces exactly one on-chain settlement, indexer processes the same block twice without double-crediting, AI down returns fallback within 1 s.

---

## 10. Phase 5 — Video worker (`workers/video-processor`)

BullMQ consumer for `transcode`, concurrency from `TRANSCODE_CONCURRENCY` (default 1).

1. `ffprobe` the source: duration, resolution, audio presence.
2. Build the ladder: 360p and 720p always (never upscale above source), 1080p only if the source is at least 1080p. H.264 + AAC, 4-second segments, keyframes aligned to segments, VOD playlists, one master playlist.
3. Thumbnail from 10% of the duration.
4. Report progress through `job.updateProgress` by parsing FFmpeg's time output.
5. Result: manifest path, thumbnail path, duration, renditions.
6. On failure: delete partial output, fail the job with a human-readable reason. Two attempts. Handle sources with no audio track.
7. Output goes to `HLS_OUTPUT_DIR/<videoId>/`. Graceful shutdown on SIGINT/SIGTERM.

**Acceptance:** integration test transcodes a 10-second `testsrc` clip and asserts a valid master playlist, segments, thumbnail and duration; a corrupt file fails cleanly and leaves no output directory.

---

## 11. Phase 6 — AI service (`ai`)

Small Express service on port 5000. Stateless, deterministic, no external APIs, no database.

- `GET /health`
- `POST /recommend` with `{ limit, seedVideo?, history: [{category, tags, creatorId, watchedSeconds}], candidates: [{id, title, description, category, tags, creatorId, views, createdAt}] }`
- Score = weighted sum of: TF-IDF cosine similarity of title + description + tags against the seed video and the history profile; category affinity; creator affinity; popularity (log views); recency decay. Exclude already-watched candidates; diversify so one creator cannot fill the list.
- Returns ordered ids with scores.

**Acceptance:** unit tests for scoring and ordering; cold-start user (no history) returns a sensible popularity/recency order.

---

## 12. Phase 7 — Web app (`apps/web`)

Replace the single-file mock. Keep the visual identity (dark theme, purple/cyan accents, Inter).

### Pages
`/` home (hero, continue watching, recommended, trending, categories) · `/search` · `/watch/:id` · `/channel/:id` · `/login` · `/register` · `/wallet` · `/history` · `/watchlist` · `/studio` (videos, upload, edit, analytics, earnings) · `/settings` · `/admin` · 404.

### Wallet layer (ethers v6, MetaMask)
- States handled explicitly: no wallet installed (show install guidance), locked, connected to the wrong network (one-click switch, adding Amoy if missing), account changed (warn if it differs from the linked wallet), user rejected the request (quiet message, not an error screen).
- Top-up flow: amount input with validation, then permit-based single transaction; fall back to approve + deposit if signing typed data fails. Show each step, the pending transaction with an explorer link, and the confirmed result. Disable buttons while pending.
- Withdraw flow: request, countdown to unlock, execute, cancel.
- A note with a link to the Amoy faucet for gas (POL), shown only when the gas balance is zero.
- Balances come from the API summary; they refresh after confirmations and on window focus.

### Player
- hls.js with native HLS fallback; quality selector, playback speed, volume, fullscreen, keyboard shortcuts (space, arrows, `f`, `m`), remembers volume.
- Session lifecycle: start on first play; heartbeat every 10 s with a monotonic sequence; retry a failed heartbeat with the same sequence; send `end` on unmount and via `sendBeacon` on page close.
- Cost meter: verified time, charge so far, rate, remaining balance and estimated minutes left.
- `low_balance`: non-blocking banner with a top-up button. `stop`: pause, keep the position, open the top-up dialog, resume automatically after the deposit confirms.
- Network loss: show "reconnecting", pause after two missed heartbeats, resume when back. Tab hidden: keep sending heartbeats only while actually playing.
- A second tab starting playback ends the first with a clear message.

### Creator studio
Drag-and-drop upload with client-side type/size checks, progress bar, cancel; metadata form (title, description, category, tags, price per minute, thumbnail preview); transcoding status polled every 3 s; publish/unpublish; retry on failure with the reason shown; analytics (views, watch minutes, earnings per video); earnings card with on-chain claim.

### UX quality bar
- Every data view has loading (skeletons), empty, and error (with retry) states.
- No fabricated numbers anywhere. Remove all hard-coded demo values.
- Forms: inline validation, submit disabled while pending, server errors mapped to fields.
- Toasts for outcomes; confirm dialogs for destructive actions.
- Responsive from 360 px wide; nav collapses to a menu on mobile.
- Accessibility: semantic elements, labelled controls, visible focus, full keyboard operation, contrast AA.
- Silent access-token refresh; a 401 after a failed refresh redirects to login and returns the user to where they were.
- Route-level code splitting; lazy thumbnails; an error boundary per route.
- STRM amounts formatted consistently (up to 4 decimals, full precision on hover).

**Acceptance:** `tsc` and ESLint clean; component tests for the player state machine, wallet state machine and top-up flow; no console errors or warnings during the end-to-end run.

---

## 13. Phase 8 — Integration and release gate

### End-to-end (Playwright, local Hardhat chain, seeded DB)
Use a test-only EIP-1193 provider backed by a Hardhat account, injected when `VITE_E2E=1`, so no browser extension is needed.

1. Register, log in, link wallet, welcome bonus appears.
2. Play a video for 30 s: meter increases, charge matches rate × verified seconds.
3. End session: settlement becomes `SETTLED`, transaction visible in wallet history, on-chain escrow decreased by the exact amount, creator earnings increased by amount minus fee.
4. Drain balance: playback stops, top up, playback resumes.
5. Creator: upload, transcode completes, publish, video appears in the catalog and plays.
6. Creator claims earnings; token balance increases.
7. Withdraw: request, time-travel the chain, execute.
8. AI service stopped: home page still shows recommendations (fallback).
9. Chain node stopped mid-session: playback continues, settlement stays queued, completes after the node returns.
10. Redis restarted: users stay logged in, playback recovers.

### Release checklist (all must be true)
- [ ] `npm ci && npm run lint && npm run typecheck && npm test && npm run build` passes locally and in CI.
- [ ] All Playwright scenarios pass three times in a row.
- [ ] Contract tests pass with full coverage on `PaymentRouter`.
- [ ] Contracts deployed to Amoy; addresses in `contracts/deployments/80002.json`; full manual run of `docs/DEMO.md` on Amoy.
- [ ] No `any` in money or auth code; no TODOs; no placeholder text; no secrets in the repo.
- [ ] `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/DEMO.md` and the README are complete. `.env.example` lists every variable.
- [ ] Reconciliation script (`npm run reconcile`) reports zero difference between the database ledger and on-chain escrow for all users.

---

## 14. Environment variables

Existing variables keep their names. Add and document these:

| Variable | Default | Purpose |
|---|---|---|
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `7d` | Token lifetimes |
| `COOKIE_SECRET` | none (required) | Signed cookies |
| `MAX_UPLOAD_MB` | `1024` | Upload cap (update the UI text to match) |
| `HEARTBEAT_INTERVAL_SEC` | `10` | Billing heartbeat |
| `PLAYBACK_TOKEN_TTL_SEC` | `30` | Playback cookie lifetime |
| `SESSION_TIMEOUT_SEC` | `45` | Reaper threshold |
| `CONFIRMATIONS` | `1` local, `3` Amoy | Indexer and settlement finality |
| `SETTLE_BATCH_SIZE` / `SETTLE_MAX_ATTEMPTS` | `25` / `8` | Settlement worker |
| `DEPLOYER_PRIVATE_KEY` | none | Contract deployment only |
| `EXPLORER_URL` | `https://amoy.polygonscan.com` | Transaction links |
| `TRANSCODE_CONCURRENCY` | `1` | Worker |
| `AI_TIMEOUT_MS` | `800` | Recommendation call budget |
| `VITE_API_BASE` | `/api/v1` | Web client |

The all-zero `SETTLEMENT_RELAYER_PRIVATE_KEY` in `.env.example` must be rejected at startup when `NODE_ENV=production`. In development with `CHAIN_ID=31337`, default to a Hardhat account.

---

## 15. Open decisions (defaults to use unless the owner says otherwise)

Record each one in `docs/DECISIONS.md` as "default applied, awaiting confirmation".

| Decision | Default |
|---|---|
| Platform fee | 10% (`feeBps = 1000`) |
| STRM initial supply | 100,000,000 |
| Welcome bonus | 50 STRM, once per user and per wallet |
| Withdrawal delay | 15 minutes |
| Default price | 0.33 STRM per minute (already in the schema); creators may set 0 to 5 |
| Billing basis | Wall-clock seconds while playing, independent of playback speed |
| Creator onboarding | Any user can become a creator; no approval step |
| Email verification / password reset | Not included (needs an email provider) |

---

## 16. Out of scope

Live streaming, DRM (Widevine/FairPlay), mainnet deployment, fiat on-ramp, mobile apps, S3/IPFS storage providers, LLM-based features, email delivery. Do not start any of these without approval.
