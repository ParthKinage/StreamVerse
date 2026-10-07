# StreamVerse (Tesor_gp)

A Web3 pay-as-you-watch video streaming platform on Polygon. Viewers deposit **STRM** (StreamCoin) into an escrow
contract. Each video has one price: paying it unlocks the video for a limited time (48 hours by default), and the payment
is settled on-chain in batches. Creators upload videos (transcoded to adaptive HLS), set a price and claim earnings on-chain.

| Doc | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, money flow, failure behaviour |
| [`docs/API.md`](docs/API.md) | Every endpoint, error codes, billing rules |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Approved decisions, defaults awaiting confirmation, known limitations |
| [`docs/DEMO.md`](docs/DEMO.md) | Ten-minute demo script (local chain and Polygon Amoy) |
| [`e2e/README.md`](e2e/README.md) | End-to-end suite and browser notes |
| [`STREAMVERSE_BUILD_SPEC.md`](STREAMVERSE_BUILD_SPEC.md) | The build specification |
| [`TEAM_WORKFLOW.md`](TEAM_WORKFLOW.md) | Branching and review workflow |

## Prerequisites

Node.js 20 or newer (22 recommended), npm 10+, Docker (Postgres 16 and Redis 7 via `docker compose`) and FFmpeg with
FFprobe on your `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`). MetaMask (or any EIP-1193 wallet) for the browser.

## Quick start (bank-wallet prototype, default)

The default `PAYMENTS_MODE=bank` needs no blockchain and no MetaMask: viewers add money from a dummy bank account, pay per
video, and creators see what they received and can cash out. Run `npm run dev:infra`, then `npm run setup:local`, then
`npm run dev`, and follow the quick demo in [`docs/DEMO.md`](docs/DEMO.md). The steps below are for the original
blockchain mode (`PAYMENTS_MODE=chain` in `.env`).

## Quick start (blockchain mode)

With `PAYMENTS_MODE=chain` every account gets a built-in blockchain wallet (`WALLET_MODE=managed`, the default): users
buy coins, pay creators on-chain and never need MetaMask or gas, and the platform keeps a commission on each sale. Set
`WALLET_MODE=external` for the original flow where users link MetaMask. See [`docs/DEMO.md`](docs/DEMO.md) and, for a
hosted deployment, [`docs/HOSTING_BLOCKCHAIN.md`](docs/HOSTING_BLOCKCHAIN.md).

```bash
npm ci
cp .env.example .env            # on Windows: copy .env.example .env
npm run dev:infra               # terminal 1: Postgres + Redis (docker compose up)
npm run dev:chain               # terminal 2: local Hardhat node on :8545
npm run setup:local             # deploy contracts, write addresses to .env, migrate and seed the database
npm run dev                     # API :4000, web :3000, AI :5000, video worker
```

Open http://localhost:3000. Seeded accounts (password `Password123!`) and the demo script are in `docs/DEMO.md`.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Build every workspace |
| `npm run lint` / `typecheck` / `test` | Quality gates (also run in CI) |
| `npm run test:e2e` | Build, then run the Playwright suite (starts its own Redis, database, chain and services) |
| `npm run reconcile` | Compare the database ledger against on-chain escrow; exits 1 on any difference |
| `npm run setup:local` | One-command local setup (see above) |
| `npm run deploy:amoy -w @tesor_gp/contracts` | Deploy to Polygon Amoy (needs `DEPLOYER_PRIVATE_KEY`) |
| `npx hardhat platform:status --network <name>` (in `contracts/`) | Show the commission rate and the commission earned |
| `npx hardhat platform:withdraw-fees --to <address> --network <name>` | Send the earned commission to a treasury address |
| `npx hardhat platform:set-fee --bps <n> --network <name>` | Change the commission (maximum 3000 = 30%) |

## Configuration

All variables are listed with defaults and comments in `.env.example`. Secrets (`JWT_SECRET`, `COOKIE_SECRET`,
`PLAYBACK_SIGNING_SECRET`) must be changed outside local development, and an all-zero or empty
`SETTLEMENT_RELAYER_PRIVATE_KEY` is rejected when `NODE_ENV=production`. On chain 31337 a Hardhat account is used as relayer.

## Repository layout

| Path | Role |
|---|---|
| `apps/api` | Express API, chain indexer, settlement worker, session reaper |
| `apps/web` | React + Vite client |
| `workers/video-processor` | FFmpeg/HLS transcoder (BullMQ consumer) |
| `ai` | Recommendation service |
| `contracts` | Solidity (Hardhat): `StreamCoin`, `PaymentRouter` |
| `packages/shared` · `database` · `blockchain` | Shared schemas and money helpers · Prisma · ABIs and chain SDK |
| `e2e` | Playwright scenarios |

Only `apps/api` imports `@tesor_gp/database`; the worker and the AI service have no database access.

## Troubleshooting

- **`Cannot connect to Redis/Postgres`:** `npm run dev:infra` must be running; check `DATABASE_URL` and `REDIS_URL`.
- **Wallet shows "wrong network":** add the local network (chain id 31337, RPC `http://127.0.0.1:8545`) to your wallet.
- **Welcome bonus or deposit not visible yet:** balances follow the chain indexer; allow up to `CONFIRMATIONS` blocks and
  a few seconds.
- **Upload stays "Processing":** make sure the worker is running and FFmpeg is installed (`ffmpeg -version`).
- **Settlements stuck in `PENDING`:** the chain RPC is unreachable or the relayer has no gas. `Admin > Settlements` shows
  the last error; retry from there once fixed.
