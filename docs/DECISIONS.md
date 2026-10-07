# Decisions

Status values: **approved** (in `STREAMVERSE_BUILD_SPEC.md` section 3), **default applied, awaiting confirmation**
(section 15, used unless the owner says otherwise), **implementation choice** (made while building, reversible),
**UNKNOWN** (could not be decided or verified from the build environment).

## Approved by the spec (A1 to A12)

| # | Decision | Where it lives |
|---|---|---|
| A1 | Prepaid escrow with batched settlement; no per-heartbeat transactions | `contracts/contracts/PaymentRouter.sol`, `apps/api/src/modules/settlement` |
| A2 | Two-step timelocked withdrawals | `requestWithdraw` / `executeWithdraw` |
| A3 | OpenZeppelin contracts, `StreamCoin` = `ERC20` + `ERC20Permit` | `contracts/contracts/StreamCoin.sol` |
| A4 | Local Hardhat chain 31337 for dev and tests, Amoy for the demo | `CHAIN_ID` |
| A5 | Money is never a float (bigint in code, `Decimal(38,18)` in the DB, wei strings in the API) | `packages/shared/src/money.ts` |
| A6 | Email + password, 15 min JWT in memory, rotating hashed refresh token in an httpOnly cookie | `apps/api/src/modules/auth` |
| A7 | HMAC playback token (30 s) in an httpOnly cookie scoped to the session path | `apps/api/src/modules/playback` |
| A8 | BullMQ queues `transcode` and `settlement` | `workers/video-processor`, `apps/api/src/modules/settlement` |
| A9 | Worker and AI service have no DB access; only `apps/api` imports `@tesor_gp/database` | package dependencies |
| A10 | `StorageProvider` interface. `local` and `s3` (any S3-compatible service) are implemented; `ipfs` fails at startup. Amended by D-STORAGE below (TESOR_LIVE_BUILD_SPEC C2.1, owner request) | `apps/api/src/infra/storage`, `packages/storage` |
| A11 | react-router, react-query, hls.js, ethers v6, CSS variables | `apps/web` |
| A12 | Vitest, Supertest, Hardhat, Playwright, ESLint | all workspaces |

## Open decisions: default applied, awaiting confirmation

| Decision | Default applied | Status |
|---|---|---|
| Platform fee | 10% (`feeBps = 1000`), set at deploy time (`FEE_BPS`) | default applied, awaiting confirmation |
| STRM initial supply | 100,000,000 STRM (`STRM_INITIAL_SUPPLY`) | default applied, awaiting confirmation |
| Welcome bonus | 50 STRM, once per user and once per wallet (`WELCOME_BONUS_STRM`) | default applied, awaiting confirmation |
| Withdrawal delay | 15 minutes (`WITHDRAW_DELAY_SEC`) | default applied, awaiting confirmation |
| Pricing | One price per video (default 20, max 500), paid once to unlock for 48 hours (`ACCESS_HOURS`); replaced the earlier per-minute billing at the owner's request | owner request; 48 hours is a default awaiting confirmation |
| Creator onboarding | Any user can create a channel; no approval step | default applied, awaiting confirmation |
| Email verification / password reset | Not included (needs an email provider) | default applied, awaiting confirmation |

## Implementation choices

- **Prisma 7 with the `pg` driver adapter.** The Prisma schema engine binary cannot be downloaded in some environments
  (sandboxes, restricted CI), so `prisma migrate dev` could not be used to generate the baseline. The initial migration
  (`packages/database/prisma/migrations/20261003000000_init`) is hand-written SQL that mirrors `schema.prisma`; it is
  applied with `prisma migrate deploy` and by the e2e harness directly. **UNKNOWN:** a `prisma migrate diff` drift check
  between the migration and the schema was not run here; run it once where the engine can be downloaded.
- **Solidity compiler.** Hardhat downloads `solc` from a CDN that is blocked in restricted environments, so `contracts/hardhat.config.js`
  overrides the compiler task to use the pure-JS `solc` npm package (`soljson.js`).
  OpenZeppelin is pinned to `~5.1.0` so the contract sources compile with the pinned compiler.
- **Extra schema columns** beyond the spec's list were added where the algorithms needed durable state (session
  sequence and last-heartbeat timestamp, settlement attempts/last error/tx hash, transcode progress and failure
  reason, refresh-token family and hash, wallet nonce bookkeeping). All are listed in `schema.prisma`.
- **Withdrawal draws.** A settlement may draw from escrow first and then from a pending withdrawal (the contract
  guarantees viewers cannot dodge unsettled charges by requesting a withdrawal). A settlement that reverts because of
  such a draw needs `executeWithdraw`/time to pass before retry; the admin retry endpoint covers it.
- **Rewards share the settlement queue.** The welcome bonus is a `reward` job on the same BullMQ queue (concurrency 1) so
  the relayer's nonce is never used by two workers at once.
- **Rendition ladder.** 360p and 720p are always produced and never upscaled. A source shorter than 720 lines is encoded
  at its own size but labelled "720p" so every video has the same two variants and the player's quality menu stays simple. 1080p
  is produced only for sources of at least 1080 lines. Segments are 4 s with forced keyframes.
- **Recommendation scoring.** TF-IDF cosine similarity over title, description, category and tags; category and creator
  affinity from watch history; log popularity; recency decay; a single creator takes at most 40% of the result list; ties
  break by id so results are deterministic.
- **Rate limits** are per IP per minute (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`) and are raised in the e2e harness.
- **Web balance polling.** Wallet summary, transactions and creator earnings refetch every 10 s (and on focus), because
  welcome bonuses and settlements arrive through the chain indexer and would otherwise only appear after a reload.
- **Registration redirect.** The register page keeps its `pending` flag set on success so that the "already signed in"
  redirect cannot override the navigation to `/wallet` (found by the onboarding e2e scenario).

## Prototype bank-wallet mode (`PAYMENTS_MODE=bank`, the default)

Requested after the platform build: viewers add money "from a bank account" (no crypto, no MetaMask), pay per video,
and creators see "x received". The blockchain stays in the codebase and is selected with `PAYMENTS_MODE=chain`.

- **Simulated bank.** There is no real bank or payment provider. Three dummy accounts exist (`demo-savings` ••4242,
  `demo-current` ••1111, `demo-declined` ••0002). The last one always answers 402 `BANK_DECLINED`, to demo failures.
- **Same engine, different settlement.** Purchases, the segment budget and escrow accounting are shared. The
  wallet balance reuses `EscrowAccount.onChainBalance`; the name is historical in this mode. Settlement is one DB
  transaction (claim by `escrowAppliedAt`, debit the viewer, mark SETTLED, credit the creator) that runs inline when a
  session ends, plus a 5 s sweep for stragglers. No `ChainEvent` rows are written.
- **Creator money.** Creators see each payment ("received") and a claimable balance. Cash out pays all claimable money to
  a chosen dummy account (`LedgerEntry` type `CREATOR_PAYOUT`).
- **Default applied, awaiting confirmation: currency.** Indian rupee, `CURRENCY_CODE=INR`, `CURRENCY_SYMBOL=₹`. It is a
  display label only; amounts keep 18-decimal precision internally. Change both variables to switch.
- **Default applied, awaiting confirmation: platform fee.** `PLATFORM_FEE_BPS=0`, so creators receive 100% in bank mode.
  Chain mode keeps the on-chain fee.
- **Limits.** Top-up between 10 and 50000 units (`BANK_MIN_TOPUP`, `BANK_MAX_TOPUP`).
- **Prices.** Video prices are per video (default 20, max 500), read as rupees in bank mode. The migration converted old per-minute rates to `rate x duration in minutes` (minimum one minute), rounded to 2 decimals.
- **Wallet linking** (`/wallet/nonce`, `/wallet/link`) answers 404 `NOT_AVAILABLE_IN_THIS_MODE` in bank mode.
- **Ledger.** New table `LedgerEntry` (migration `20261004000000_demo_bank_ledger`) holds bank top-ups, withdrawals and
  creator payouts. Money columns are `Decimal(38,18)`.
- **e2e.** The 10 existing Playwright scenarios run the stack with `PAYMENTS_MODE=chain`. The bank flow is covered by
  13 API tests and web unit tests; there is no browser scenario for it yet.

## Built-in wallets and the earning model (`PAYMENTS_MODE=chain`, `WALLET_MODE=managed`)

Requested by the owner after the first hosted deployment: every user and every creator has a blockchain wallet with
money in it, what a viewer spends is transferred to the creator, nobody needs MetaMask or gas, and the platform earns a
commission. This is now the default wallet mode on a chain. Linking a browser wallet is still available with
`WALLET_MODE=external`.

- **Custody.** The platform holds the wallets (a custodial model, like an exchange account). Each wallet is a normal
  Ethereum account derived from one secret, `WALLET_MASTER_SEED`, at `m/44'/60'/0'/0/<index>`. The database stores only
  the index and the address (`ManagedWallet`), never a key, so a database leak exposes no wallet. Whoever holds the seed
  controls every wallet, so it must stay secret and must never change. The key of any wallet can be re-derived later,
  for example to let a user export it or to add cash-out.
- **Wallets are automatic.** A wallet is created at sign-up and at sign-in for older accounts, and a startup task gives
  one to every account that lacks it (including seeded demo accounts, whose public test addresses are replaced).
- **Nobody but the platform pays gas.** Users' wallets never send a transaction. The relayer (`SETTLER_ROLE`) does
  three things on their behalf, and the contract only lets each one move money to the account it belongs to:
  `creditBatch` adds coins a viewer bought or was given to the viewer's escrow, `settleBatch` moves a payment from the
  viewer to the creator and the platform, and `claimEarningsFor` pays a creator's earnings to the creator's own address.
- **Contract changes.** `PaymentRouter` gained `creditBatch`, `credited(id)`, the `Credited` event and
  `claimEarningsFor`. A credit carries a unique id, so a retried or duplicated transaction can never credit twice.
  The token contract is unchanged. `depositFor` and the user-signed functions remain for linked wallets.
- **Buying coins.** `POST /wallet/topup` records a `CoinOrder` paid from a demo bank account (1 unit of currency buys
  1 STRM; nothing real is charged) and the relayer credits it on-chain. Coins can be spent once the indexer has seen the
  confirmed credit; until then they are shown as "on its way". A real payment gateway replaces only the demo bank step:
  confirm the payment, then create the same `CoinOrder`. Limits: `BANK_MIN_TOPUP` to `BANK_MAX_TOPUP` per purchase and
  `TOPUP_DAILY_LIMIT_STRM` per account per 24 hours, which also bounds how fast a public demo can drain the coin pool.
- **Credits never get lost.** A credit that cannot be sent (RPC down, relayer out of gas or coins) stays `PENDING` and
  is retried by the sweeper indefinitely. Only a credit the contract can never accept is marked `FAILED`.
- **Viewers do not withdraw.** With built-in wallets, coins are platform credit: there is no viewer withdrawal and no
  wallet unlinking. Cash-out to real money is a future step (see below).
- **Creator payout.** `POST /creator/earnings/payout` queues one `claimEarningsFor` transaction. The coins land in the
  creator's own wallet as ordinary STRM tokens, visible on the explorer. Payouts below `MIN_PAYOUT_STRM` are refused
  because each one costs the platform gas, and only one payout per creator is in flight at a time.
- **Earning model.**
  1. *Commission on every sale* (implemented). The contract keeps `feeBps` of each payment: with the default 3000
     (30%), a 10 STRM video pays 7 to the creator and 3 to the platform. The rate is set at deployment (`FEE_BPS`), can
     be changed by the contract admin (`platform:set-fee`) and is capped at 30% in the contract itself, so creators can
     verify it. The commission accrues in the contract and the admin withdraws it with `platform:withdraw-fees`.
  2. *The platform pays all gas out of that commission.* Costs are kept low by batching: payments and coin purchases
     made within `BATCH_WINDOW_MS` share one transaction (up to 100 items). Measured on the local chain: about 100,000
     gas for a batch with one item and far less per extra item, roughly 0.003 POL per transaction at 30 gwei.
  3. *Later, with real money* (not implemented): a margin on coin sales, a cash-out fee for creators, and paid
     promotion of videos. The coin order and the payout are the two places a payment gateway connects.
- **Admin revenue page.** `GET /admin/revenue` and the Revenue tab show sales, commission earned, commission ready to
  withdraw, coins sold, bonuses given, and the relayer's gas and coin balances, with a warning when gas is low.
- **Switching ledgers.** Balances and payments in the database describe one ledger (the demo bank, or one contract on
  one chain). `AppSetting.ledgerScope` records which. If the app starts against a different one, the old records are
  wrong. Moving from the demo bank to a chain clears them automatically, because demo-bank money was simulated.
  Moving between real ledgers (another chain, a newly deployed contract, or back to the bank) clears them only with
  `LEDGER_RESET_ON_CHANGE=true`; otherwise the mismatch is logged as an error and nothing is touched. A reset keeps
  accounts, videos and wallet addresses, and welcome bonuses are granted again.
- **Switching from linked wallets to built-in wallets** replaces each account's linked address with its built-in one.
  Coins a user had deposited from their own wallet stay in the contract under that old address, and they can still
  withdraw them with that wallet.
- **Public demo caveat.** Every sign-up receives the welcome bonus and costs the relayer a little gas, and the demo
  bank hands out coins for free. Rate limits and the daily purchase limit slow abuse down but do not prevent it; lower
  `WELCOME_BONUS_STRM` and `TOPUP_DAILY_LIMIT_STRM` for a public site.
- **The server's RPC URL is never sent to browsers** (it usually contains a private API key). Browsers get
  `PUBLIC_RPC_URL`, which defaults to the public endpoint of the chain.
- **Fee shown to users** comes from the contract (cached, refreshed in the background), not from the deployment file.
- **Tests.** 6 new contract tests, 2 adapter tests, 21 API tests (`modules/managed`), web unit tests for the buy-coins
  dialog and the earnings card, and one browser scenario (`e2e/tests/11-built-in-wallet.spec.ts`, run with
  `E2E_WALLET_MODE=managed`). The 11 existing browser scenarios still run with linked wallets.
- **Not verified:** the Amoy deployment and the hosted site on Amoy. Everything above was verified on the local chain.
- **Not legal advice:** selling a token for real money and holding users' wallets are regulated in many countries.
  Get this checked before taking real payments.

## Object storage and playback delivery (TESOR_LIVE_BUILD_SPEC Part C)

**Why.** On the hosted site the API kept media on the container disk (`STORAGE_PROVIDER=local`). Render's free plan has
no persistent disk, so files vanished on every restart while the database still listed the videos as `COMPLETED`.
Confirmed on 2026-10-07: thumbnails of earlier uploads returned 404 "Thumbnail not found" (the code path that means the
row exists but the file does not), and the Render log showed a new upload transcoding and playing until the next
restart. Transcoding itself finished (360p + 720p of a 29 s clip in about 70 s), so out-of-memory was not the cause at
that size.

| # | Decision | Status |
|---|---|---|
| D-STORAGE | Media lives in an S3-compatible bucket (`STORAGE_PROVIDER=s3`). One package, `@tesor_gp/storage`, is the only code that talks to it (API, worker and seed use it). Keys: `originals/<userId>/<uuid>.<ext>` and `hls/<videoId>/<version>/...`; every transcode writes a new version folder, so a retry never overwrites files being played and thumbnail URLs can be cached for a long time. `local` stays for development and the existing tests. | owner request (spec C2.1) |
| D-STORAGE-SERVICE | **Backblaze B2**, bucket `streamverse-media`, region `us-east-005`, private. Chosen by the owner after comparing (2026-10-07, from the providers' current pages): B2 free tier = 10 GB storage, egress free up to 3x the average stored data per month then $0.01/GB, class A/B/C calls free; sign-up needs no card. Cloudflare R2 (10 GB, free egress) was preferred technically but asked for a card. Supabase free (1 GB, 5 GB egress, 50 MB per file, project paused after a week idle) was too small. The code is provider-neutral; switching is a change of `S3_*` settings. | owner decision |
| D-UPLOAD | Direct upload: `POST /creator/uploads` returns a presigned PUT URL (`UPLOAD_URL_TTL_SEC`, default 1 h) bound to the content type; the browser uploads to the bucket; `POST /creator/uploads/complete` checks size (S3 cannot cap a presigned PUT, so the API checks with HEAD), type and a real video stream (ffprobe over a short signed GET URL), then queues the transcode. The completion token is an HMAC (same secret as playback tokens, domain-separated) binding the object key, user, announced size and type; completing twice returns the first video. Multipart `POST /creator/videos` still works in both modes. | implementation choice |
| D-PLAYBACK-URLS | Playlists still pass through the API (session cookie, purchase and session checks unchanged). The API rewrites each media playlist so every segment line is a signed bucket URL; segments never touch the API. Segment *i* is signed for `start_i + SEGMENT_URL_SLACK_SEC` (default 600 s), so a viewer who presses play can watch to the end while a copied playlist stops working soon after. Playlists are cached in API memory for 10 minutes (version folders never change). | implementation choice |
| D-SEGMENT-BUDGET | **Trade-off, owner to confirm.** S3 signatures have an expiry but no "not before", so a signed playlist lets a client fetch every segment at once; the per-segment budget (`1.5 x verified + 120 s`) can no longer be enforced byte by byte in `s3` mode. For video on demand this costs nothing: the viewer has already paid for 48 h of access to the whole video. The budget is enforced at the token/playlist step instead (active session, valid purchase, short-lived URLs). `local` mode keeps the per-segment budget. For live streaming (Part E) the playlist is naturally a sliding window, which is where the budget matters for per-minute billing. | implementation choice, awaiting confirmation |
| D-THUMBS | Thumbnails: `GET /videos/:id/thumbnail?v=<version>` redirects (302) to a signed bucket URL valid 7 days and reused for a day; the redirect is cacheable for a day when the URL carries the version. | implementation choice |
| D-LADDER | `TRANSCODE_LADDER` (any of 360p, 480p, 720p, 1080p; 1080p only for sources of at least 1080 lines) and `TRANSCODE_THREADS`. Defaults: `360p,720p,1080p` and FFmpeg's own thread count in development; the Docker image sets `480p` and 2 threads for the small Render instance. Each job logs wall time and peak FFmpeg memory (from `-benchmark`). Measured locally: a 20 s 720p H.264 clip to 480p took 2.2 s with 145 MiB peak FFmpeg memory. | implementation choice |
| D-WORKER-SERVICE | The worker stays in the API container for now. With the original out of the container (downloaded to a temp folder per job and deleted after) and one 480p rendition, a 512 MB instance has room for it. Move it to its own service when uploads get longer than a few minutes or when the API host changes (Part D1). | implementation choice, revisit with Part D |
| D-RECONCILE | `MEDIA_RECONCILE_EVERY_MIN` (default 60; first run 30 s after start): every `COMPLETED` video whose master playlist is missing becomes `FAILED` with "The video files are no longer in storage. Upload the video again." and is unpublished. A storage error never counts as missing. Rows that still hold local paths after the switch to `s3` count as missing, which is how the videos lost on Render get cleaned up. | implementation choice |
| D-PLAYER-ERRORS | The player names the problem (not found, not authorised, still processing, network, decoding) and offers Retry. Transient network errors (no answer, 429, 5xx) are retried with back-off; 4xx are not retried by hls.js. A 401/403 on a segment (signed URLs ran out after a long pause) reloads the playlist and continues at the same position. Cookies are only sent to our own origin, never to the bucket. | implementation choice |
| D-LOCAL-S3 | Tests and local development use `versity/versitygw:v1.8.0` (docker-compose service `s3`, port 7070, development-only keys) because the MinIO image is no longer published on Docker Hub. It checks SigV4 signatures and supports bucket CORS, so signing bugs fail in tests. | implementation choice |

## Relayer gas on Polygon Amoy (owner chose option 1: stay on Amoy, need less gas)

Found on 2026-10-07: welcome bonuses stayed "on the way" because the relayer (0.0186 POL) could not send a batch.
The node refuses a transaction unless the sender holds gas limit x the fee ceiling; ethers offered 2 x base fee + tip
(85 gwei while Amoy charged 55), so 8 bonuses needed 0.045 POL up front although they cost about 0.025.

| # | Decision | Status |
|---|---|---|
| D-FEE-CAP | The relayer's provider offers base fee x 1.25 + tip (`feeHeadroomPct`, default 25) as the fee ceiling. On Amoy that day: 62.5 gwei instead of 85. If the base fee rises more than 25% before inclusion the transaction waits in the mempool until it falls back; nothing is lost. | implementation choice |
| D-AFFORDABLE-BATCH | Credits and settlements that fail with insufficient gas are retried with the oldest half, down to one item; the rest wait for the next run. | implementation choice |
| D-LOW-GAS | `LOW_GAS_MILLI` default raised from 20 (0.02) to 150 (0.15): what a full batch must hold up front. | implementation choice |
| D-INDEXER-RANGE | Found 2026-10-07: balances stayed 0 although bonuses were confirmed, because the hosted RPC (Alchemy free plan) refuses `eth_getLogs` over more than 10 blocks and the indexer asked for 2,000. The indexer now steps down through 2000, 1000, 500, 100, 50, 10, 5, 1 until the RPC accepts, steps back up after 50 successes, and keeps reading for up to 10 s per tick while behind. `INDEXER_MAX_BLOCK_RANGE` sets the starting size. Catching up 4,856 blocks through that RPC was estimated at about 2 minutes of requests. | implementation choice |
| D-CHAIN-ALTERNATIVES | Compared on 2026-10-07: Base Sepolia (cheap gas, but its Alchemy faucet needs 0.001 ETH on Ethereum mainnet), Tenderly Virtual TestNets (unlimited faucet, but the free plan has no public endpoint and stops at 50 blocks), a self-hosted chain (needs a paid server with a disk). Owner kept Polygon Amoy, topped up from faucets (Alchemy 0.1 POL per 24 h, QuickNode every 12 h). | owner decision |

## Limitations and unverified items (UNKNOWN)

| Item | Why it could not be completed in the build environment |
|---|---|
| Deployment to Polygon Amoy (`contracts/deployments/80002.json`) | Needs a funded deployer key and network access to Amoy. Never invent addresses; run `npm run deploy:amoy -w @tesor_gp/contracts` with `DEPLOYER_PRIVATE_KEY` set. |
| Manual run of `docs/DEMO.md` on Amoy | Depends on the item above and a real browser wallet. |
| Playwright with real H.264 playback | The Chromium shipped with Playwright has no H.264 decoder and Chrome could not be downloaded. The suite therefore supports `E2E_FAKE_MEDIA=1`, which replaces the media element with a clock and still fetches the manifests and segments with the playback cookie, so billing, the segment budget and settlement are exercised for real. CI runs the suite with the Chrome channel (real decoding). |
| `prisma migrate dev` drift check | Needs the Prisma schema engine (see above). |
| Creator approval, email flows, IPFS, DRM, live streaming | Out of scope (spec section 16). |
| Object storage on the hosted site | Verified by tests (versitygw) and, on 2026-10-07, against the real Backblaze B2 bucket from a local API and worker in a real browser: `npm run setup:bucket` passed with a key limited to `streamverse-media` (it was allowed to set CORS), a 20 s clip uploaded straight to B2, transcoded, published and played with every segment from B2 (first segment 2.7 s, then about 0.45 s each, from India to us-east-005), and deleting the video removed its files from the bucket. Not yet run on Render. B2's documentation does not state a maximum presigned URL lifetime; we only use minutes to days, below the SigV4 maximum of 7 days. |
| Browser scenario for upload to playback against storage (spec C3) | Checked by hand in a real browser against the local stack (upload, transcode, publish, play, restart, play again, missing files). The Playwright suite needs a `redis-server` binary, which is not installed on the owner's Windows machine, so the suite was not run. |
