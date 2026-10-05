# Demo script

## Quick demo: bank wallet (default mode)

No chain, no MetaMask, no `dev:chain` needed. Seeded password for all users: `Password123!`.

1. Log in as `viewer1@streamverse.test`. Open **Wallet**, click **Add money**, choose "Demo Savings ••4242", amount 500,
   **Add money**. The balance chip in the top bar shows the new amount.
2. Open a paid video. The page shows **Unlock for ₹20** (48 hours of access). Click it, then press **Play**. Watching costs nothing more; the Wallet shows "Unlocked: ..." and the balance dropped once.
3. Log in as the video's creator (for example `creator1@streamverse.test`). **Wallet** shows "Money received" with a line
   such as "₹0.50 received from viewer1 for ...", and "Available to cash out".
4. Click **Cash out to bank**. The transactions table shows the payout.
5. To see a failure, add money from "Always Declines ••0002": the bank declines it.

Chain mode (below) is the original token-on-a-blockchain demo, selected with `PAYMENTS_MODE=chain`.

---

## Chain mode demo


A ten-minute walkthrough that shows every part of the product. It runs on the local Hardhat chain by default; the Amoy
variant is at the end. All steps use the browser wallet (MetaMask) unless noted.

## 0. Prepare

```bash
npm ci
cp .env.example .env                 # Windows: copy .env.example .env
npm run dev:infra                    # Postgres + Redis
npm run dev:chain                    # Hardhat node on :8545 (leave running)
npm run setup:local                  # deploys contracts, writes addresses into .env, migrates, seeds
npm run dev                          # API :4000, web :3000, AI :5000, video worker
```

Seeded accounts (password `Password123!`):

| Account | Role |
|---|---|
| `admin@streamverse.test` | Admin |
| `creator1@streamverse.test`, `creator2@streamverse.test` | Creators with published videos |
| `viewer1@streamverse.test` to `viewer3@streamverse.test` | Viewers without a wallet |

In MetaMask add the local network (RPC `http://127.0.0.1:8545`, chain id `31337`, symbol ETH) and import one of the
Hardhat development keys printed by `npm run dev:chain`. Hardhat account 0 holds the STRM supply; send some STRM to your
demo account (`npm run dev:chain` output explains the accounts; the web wallet page shows your STRM balance).

## 1. Sign up and get the welcome bonus (1 min)

1. Open http://localhost:3000, choose **Sign up**, create an account.
2. On the Wallet page choose **Connect wallet**, approve in MetaMask, then **Link wallet** and sign the message (free).
3. Within a few seconds the balance shows **50 STRM** and the history lists **Welcome bonus**.

## 2. Unlock and watch (2 min)

1. Open a paid video. Play is locked; the page offers **Unlock for X STRM** with the access period.
2. Click **Unlock** and approve nothing extra: the payment comes from your escrow balance. Then choose **Play**.
3. Open **Wallet**: the payment becomes an **Unlocked: ...** entry once the settlement transaction confirms, and the
   explorer link opens the transaction. Watching again within the access window costs nothing.

## 3. Run out of balance (2 min)

1. In **Wallet** choose **Request withdrawal** for almost your whole balance (it stays pending for 15 minutes).
2. Open an expensive video. The page says how much more you need and offers **Top up** instead of Unlock.
3. Enter an amount, **Deposit**. Approve the token allowance and the deposit in MetaMask. When it confirms, **Unlock**
   becomes available.

## 4. Be a creator (3 min)

1. Open **Studio**, create a channel, then **Upload** a short MP4, set one price for the whole video (0 to 500 STRM) and upload.
2. Watch the progress bar while the worker builds the 360p/720p (and 1080p when the source allows) HLS ladder.
3. **Publish**. The video appears on the home page. Watch it from a second account to generate earnings.
4. **Wallet > Claim earnings** sends the accrued STRM to your wallet.

## 5. Withdraw (1 min)

Request a withdrawal, watch the countdown, and choose **Withdraw now** after the delay. On the local chain you can skip
the wait with `evm_increaseTime`; on Amoy wait the 15 minutes.

## 6. Resilience tour (optional)

- Stop the AI service (`Ctrl+C` its pane): the home page still lists videos (trending fallback).
- Stop the Hardhat node while watching: playback continues; **Admin > Settlements** shows the batch pending. Restart the
  node and it settles on its own.
- Open **Admin** (sign in as the admin): health, queue depth and settlement retry.

## 7. Check the books

```bash
npm run reconcile
```

Prints each user's database escrow against the contract and exits non-zero on any difference.

## Running on Polygon Amoy

1. Fund a deployer account with test POL from the Polygon faucet.
2. Set in `.env`: `CHAIN_ID=80002`, `POLYGON_AMOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `SETTLEMENT_RELAYER_PRIVATE_KEY`
   (a funded account that will pay settlement gas), `EXPLORER_URL=https://amoy.polygonscan.com`.
3. `npm run deploy:amoy -w @tesor_gp/contracts`. Copy the printed addresses into `STREAMCOIN_TOKEN_ADDRESS`,
   `PAYMENT_ROUTER_ADDRESS` and `DEPLOYMENT_BLOCK`; the script also writes `contracts/deployments/80002.json`.
4. Migrate and seed (`npm run prisma:deploy -w @tesor_gp/database`, `npm run seed -w @tesor_gp/database`) and start the stack.
5. Follow sections 1 to 7 above. Use the Polygon faucet for gas in each demo wallet and transfer STRM from the deployer.

Status: this repository's Amoy deployment and the manual Amoy run have **not** been performed (they need funded keys and
network access); see `docs/DECISIONS.md`.
