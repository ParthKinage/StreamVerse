# Hosting StreamVerse on a blockchain

This is the procedure for running the hosted site with real on-chain payments and built-in wallets. It uses Polygon Amoy
(a public test network: the coins have no value). The same steps work for any EVM chain; only the chain id, the RPC URL
and the explorer change.

## What runs where

| Piece | Role |
|---|---|
| `StreamCoin` contract | The STRM token. |
| `PaymentRouter` contract | Holds viewers' coins, splits each payment between the creator and the platform, pays creators out. |
| Deployer wallet | Deploys the contracts and is their admin. Used only from your own computer. Holds the unsold coins at first. |
| Relayer wallet | The platform's working wallet. The API uses it to write purchases, payments and payouts to the chain, and it pays all gas. Its key lives in the API's environment. |
| Built-in wallets | One per account, derived from `WALLET_MASTER_SEED`. They never send transactions and never need gas. |

## One-time setup

1. **Two wallets.** Create a Deployer and a Relayer account in MetaMask and export both private keys. Use fresh
   accounts that hold nothing of value.
2. **Gas.** Get test POL from a faucet for both. Measured on Amoy on 2026-10-07: the router plus the role grant and the
   coin transfer to the relayer take about 1.79 million gas (router alone 1.67 million), which is 0.054 POL at 30 gwei
   and 0.098 POL at the 55 gwei Amoy was charging that day. Keep at least 0.15 POL on the Deployer so a price spike
   cannot stop the deployment half-way. The Relayer then spends roughly 0.003 POL per transaction, and one transaction can carry
   many purchases or payments, so start it with at least 0.1 POL.
3. **Local `.env`** (never commit it):
   Keys may be written with or without the leading `0x` (MetaMask exports them without it).
   `https://rpc-amoy.polygon.technology`, the built-in default, did not resolve on 2026-10-07; always set
   `POLYGON_AMOY_RPC_URL` (`https://polygon-amoy-bor-rpc.publicnode.com` answered that day; a provider URL with your own
   API key is more reliable, and must never be committed).
   ```
   CHAIN_ID=80002
   POLYGON_AMOY_RPC_URL=<a reliable RPC URL, for example from Alchemy or Infura>
   DEPLOYER_PRIVATE_KEY=0x...
   SETTLEMENT_RELAYER_PRIVATE_KEY=0x...
   EXPLORER_URL=https://amoy.polygonscan.com
   AMOY_GAS_PRICE_GWEI=30
   FEE_BPS=3000
   ```
4. **Deploy.** `npm run deploy:amoy -w @tesor_gp/contracts`. It prints the two contract addresses and writes
   `contracts/deployments/80002.json`, which also holds `deploymentBlock`. If a deployment stops half-way after the
   token was created, set `REUSE_STREAMCOIN_ADDRESS=<token address>` and run it again: only the remaining steps run.
5. **Wallet seed.** Generate it once and keep it somewhere safe:
   `node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"`

## API environment (for example on Render)

Set these together in one save, then deploy:

| Variable | Value |
|---|---|
| `PAYMENTS_MODE` | `chain` |
| `WALLET_MODE` | `managed` |
| `WALLET_MASTER_SEED` | the seed from step 5 |
| `CHAIN_ID` | `80002` |
| `POLYGON_AMOY_RPC_URL` | your RPC URL |
| `STREAMCOIN_TOKEN_ADDRESS` | from the deployment |
| `PAYMENT_ROUTER_ADDRESS` | from the deployment |
| `DEPLOYMENT_BLOCK` | `deploymentBlock` from `80002.json` |
| `SETTLEMENT_RELAYER_PRIVATE_KEY` | the Relayer key (never the Deployer key) |
| `EXPLORER_URL` | `https://amoy.polygonscan.com` |

The API refuses to start in production when the relayer key or the wallet seed is missing, so a half-configured deploy
fails loudly instead of running in a broken state. On the first start it applies the database migration, clears the old
demo-bank balances (that money was simulated), gives every existing account a wallet and queues their welcome bonus.

If you later deploy a new contract or move to another chain, start once with `LEDGER_RESET_ON_CHANGE=true` so the
records of the old one are cleared, then set it back to `false`.

## Checking that it works

1. Sign up on the site. The wallet page shows an address; the 50 STRM bonus is confirmed within about half a minute.
2. Open the address on the explorer: the `Deposited` event from the payment contract is there.
3. Buy coins, unlock a video, then sign in as the creator and press **Pay out to my wallet**.
4. As an admin, open **Admin**, **Revenue**. "Commission earned" should be 30% of the sale.

## Running it

- **Gas.** Watch "Gas balance" on the Revenue tab. When it is low the page says so; send POL to the relayer address
  shown there. If the relayer runs out, nothing is lost: purchases and payments wait and go through when it is funded.
- **Coins.** The relayer starts with 1,000,000 STRM to sell and give away ("Coins left to sell"). Send it more from the
  Deployer wallet when needed.
- **Collecting the commission.** From `contracts/` on your computer:
  `npx hardhat platform:status --network polygonAmoy` and
  `npx hardhat platform:withdraw-fees --to <treasury address> --network polygonAmoy`.
- **Changing the commission.** `npx hardhat platform:set-fee --bps 2000 --network polygonAmoy` (maximum 3000).
- **Never change `WALLET_MASTER_SEED`.** Every wallet address comes from it.

## Other chains

- **Polygon mainnet** uses real POL for gas and is the route to real money. Change `CHAIN_ID`, the RPC URL and the
  explorer, deploy again and start once with `LEDGER_RESET_ON_CHANGE=true`. Selling coins for real money and holding
  users' wallets are regulated activities in many countries: get that checked first.
- **Your own chain.** The code only needs an EVM JSON-RPC endpoint, so a private chain works too (set `RPC_URL`). It
  needs a server with a disk to keep its history; on free hosting it would start empty after every restart.

## Real payments later

Only two places change. Buying coins: replace the demo bank step in `apps/api/src/modules/managed/coins.ts` with a
payment gateway and create the `CoinOrder` when the gateway confirms the payment. Creator cash-out: add a step after the
payout that exchanges the creator's STRM for money. Everything on-chain stays as it is.
