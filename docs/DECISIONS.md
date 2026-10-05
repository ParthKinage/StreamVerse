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
| A10 | `StorageProvider` interface, only `local` implemented; `s3`/`ipfs` fail at startup | `apps/api/src/modules/media` |
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

## Limitations and unverified items (UNKNOWN)

| Item | Why it could not be completed in the build environment |
|---|---|
| Deployment to Polygon Amoy (`contracts/deployments/80002.json`) | Needs a funded deployer key and network access to Amoy. Never invent addresses; run `npm run deploy:amoy -w @tesor_gp/contracts` with `DEPLOYER_PRIVATE_KEY` set. |
| Manual run of `docs/DEMO.md` on Amoy | Depends on the item above and a real browser wallet. |
| Playwright with real H.264 playback | The Chromium shipped with Playwright has no H.264 decoder and Chrome could not be downloaded. The suite therefore supports `E2E_FAKE_MEDIA=1`, which replaces the media element with a clock and still fetches the manifests and segments with the playback cookie, so billing, the segment budget and settlement are exercised for real. CI runs the suite with the Chrome channel (real decoding). |
| `prisma migrate dev` drift check | Needs the Prisma schema engine (see above). |
| Creator approval, email flows, S3/IPFS, DRM, live streaming | Out of scope (spec section 16). |
