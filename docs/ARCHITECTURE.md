# Architecture

StreamVerse sells each video for one price. Paying unlocks the video for a limited time. Money moves on-chain only in
batches; playback authorisation and watch time are tracked off-chain by the server.

```
Browser (React, ethers v6, hls.js)
   |  REST + httpOnly cookies (one origin)               |  wallet transactions (deposit, withdraw, claim)
   v                                                     v
apps/api (Express 5) ---- Postgres (Prisma 7)      Polygon (Amoy) / Hardhat (31337)
   |  |  \                                              ^         ^
   |  |   +-- Redis: BullMQ queues, nonces, caches,     |         |
   |  |        segment budget, rate limits              |         |
   |  +-- AI service (HTTP, stateless, 800 ms budget)   |         |
   +-- settlement worker (relayer) ----------------------+         |
   +-- chain indexer (polls PaymentRouter logs) -------------------+
workers/video-processor (BullMQ consumer, FFmpeg -> HLS on local storage)
```

## Workspaces

| Path | Role |
|---|---|
| `packages/shared` | Constants, zod request/response schemas, bigint money helpers. Used by API, web, worker and AI |
| `packages/database` | Prisma schema, migration, seed. **Only `apps/api` imports it** |
| `packages/blockchain` | ABIs, typed contract helpers, `foldEscrow` (pure event reducer), local-chain helpers |
| `contracts` | `StreamCoin` (ERC20 + Permit) and `PaymentRouter`, Hardhat tests with full line coverage |
| `apps/api` | REST API, indexer, settlement worker, session reaper, rewards |
| `apps/web` | React client: wallet state machine, billed player, creator studio |
| `workers/video-processor` | Transcoding. No DB access: reports progress through BullMQ job progress and results |
| `ai` | Recommendation scoring. No DB access: candidates and history arrive in the request |
| `e2e` | Playwright suite that boots the whole stack |

## Payments modes

`PAYMENTS_MODE=bank` (default) settles in the database: when a session ends, one transaction debits the viewer's wallet
and credits the creator, and the creator's "received" feed lists settled payments. `PAYMENTS_MODE=chain` uses the
PaymentRouter and the indexer described below. The API loads no chain adapter in bank mode, and the web client reads the
mode from `GET /config` before first render, so amounts show as ₹ or STRM accordingly.

## Money flow

1. **Deposit.** The viewer approves and calls `PaymentRouter.deposit` (or `depositWithPermit`) from their wallet. The
   indexer sees `Deposited` after `CONFIRMATIONS` blocks and credits `EscrowAccount.onChainBalance`.
2. **Purchase.** `POST /videos/:id/purchase` checks the balance under a per-user lock and, in one transaction, creates a
   `PaymentSettlement(PENDING)` plus a `VideoPurchase` with an expiry. Available balance = on-chain escrow - pending
   withdrawal - unsettled charges, so a viewer can never spend the same STRM twice before it settles. Playback sessions
   (`POST /watch/sessions`) need an active purchase; heartbeats stop the player when the window ends and only track
   server-clock watch time for views, resume and the segment budget.
3. **Settlement.** The new `PaymentSettlement(PENDING)` row is queued. The worker collects up to
   `SETTLE_BATCH_SIZE`, reconciles with chain state (ids already settled on-chain are marked `SETTLED`, never re-sent),
   simulates the batch with `staticCall`, removes items that would revert so one bad item cannot block the rest, sends
   `settleBatch`, waits for confirmations and marks the rows `SETTLED`. Failures back off exponentially up to
   `SETTLE_MAX_ATTEMPTS`, then become `FAILED` and appear in the admin panel for retry. Settlement ids are unique
   on-chain, so retries cannot double-charge.
4. **Split.** `settleBatch` debits the viewer's escrow, credits the creator `amount - fee` and the platform `fee`
   (`feeBps`, default 10%).
5. **Withdrawal.** `requestWithdraw` moves funds into a pending withdrawal that unlocks after `withdrawDelay` (15 min).
   Settlement can still draw from it, which is why the delay exists. `executeWithdraw` pays out, `cancelWithdraw` returns it.
6. **Creators** call `claimEarnings` to receive their accrued STRM.

## Chain indexer

Polls `PaymentRouter` logs from `ChainCursor`, waits `CONFIRMATIONS`, stores each log in `ChainEvent` (unique on tx hash and
log index) and applies it to `EscrowAccount` through the same `foldEscrow` reducer used in tests, so the ledger can be
replayed from events at any time. `npm run reconcile` recomputes every user's escrow from `ChainEvent` and compares it with
the contract; it exits non-zero on any difference. While the RPC is down the indexer logs and backs off; playback continues
on the last known balance and settlements stay queued.

## Playback authorisation

`POST /watch/sessions` sets an HMAC-signed cookie (`pbt`, 30 s) scoped to `/playback/<sessionId>/`; every heartbeat that
returns `continue` renews it. A stopped session is not renewed, so playback ends within 30 s. The playback route also
enforces the segment budget in Redis. HLS segments are 4 s with forced keyframes, so a rendition switch always lands on a
segment boundary.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Chain RPC down | Playback and billing continue on the last indexed balance; settlements stay `PENDING` and retry with backoff; the indexer resumes from its cursor |
| AI service down or slow | Circuit breaker (opens after 5 failures, half-open after 30 s); home and "up next" use trending, response `source: "fallback"` |
| Redis restarts | Sessions and balances live in Postgres, so users stay signed in; rate limits and the segment budget start fresh; BullMQ jobs are persisted by Redis and resume; the player's next heartbeat succeeds |
| Heartbeats stop | The reaper ends the session after 45 s and settles what was verified |
| Client lies about time | Ignored: only the server clock is used, credit per heartbeat is capped at 12 s, and the segment budget bounds downloads |
| Corrupt upload | The worker fails the job without retrying (`UnrecoverableError`); the video shows `FAILED` with a reason and can be retried |
| Wrong network / account in the wallet | The web wallet state machine blocks billed actions and explains how to fix it |

## Web client structure

Pure state machines (`walletMachine`, `sessionMachine`) are driven by hooks, which keeps the interesting behaviour unit
testable without a browser. The access token lives in memory and is restored through the refresh cookie. Under
`VITE_E2E=1` an extra EIP-1193 provider backed by `window.__E2E_WALLET__` replaces the browser extension so Playwright can
sign and send transactions on the local chain.

## Testing

| Layer | Tooling |
|---|---|
| Contracts | Hardhat, 100% line coverage of `PaymentRouter` |
| API | Vitest + Supertest against real Postgres and Redis, a Hardhat node, and a flaky RPC proxy for outage tests |
| Worker | Vitest with real FFmpeg on generated clips |
| AI | Vitest (determinism, ranking, diversification) |
| Web | Vitest + Testing Library (machines, forms, player) |
| End to end | Playwright against the real stack (see `e2e/README.md`) |
