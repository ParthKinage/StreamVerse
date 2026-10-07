# End-to-end tests

`npm run test:e2e` (from the repo root) builds everything and runs ten Playwright scenarios against a complete private
stack that the suite starts and stops itself: its own Redis, a temporary Postgres database, a Hardhat chain (behind a proxy
that can simulate outages), the AI service, the API, the video worker and the Vite dev server with `VITE_E2E=1`.

Prerequisites: a reachable Postgres (`DATABASE_URL` host and credentials are reused to create a throwaway database), a
`redis-server` binary, FFmpeg, and a built workspace.

| Scenario | File |
|---|---|
| Register, link wallet, welcome bonus | `01-onboarding` |
| Unlock a video once, play it, watching costs nothing more | `02-unlock-and-watch` |
| Unlock settles on-chain, wallet history, exact escrow and creator split | `03-settlement` |
| Cannot unlock without funds, top up, unlock | `04-low-balance` |
| Creator upload, transcode, publish, play | `05-creator-upload` |
| Claim earnings | `06-claim-earnings` |
| AI service stopped, fallback recommendations | `07-ai-down` |
| Chain outage mid-session | `08-chain-outage` |
| Redis restart | `09-redis-restart` |
| Withdrawal with chain time travel (runs last: it moves the chain clock) | `10-withdraw` |
| Built-in wallets: sign up, buy coins, unlock, creator payout, no browser wallet (only with `E2E_WALLET_MODE=managed`) | `11-built-in-wallet` |

One run uses one wallet mode. By default the stack runs with linked browser wallets and scenario 11 is skipped. Run
`E2E_WALLET_MODE=managed npx playwright test` to start the stack with built-in wallets; then only scenario 11 runs.

## Browser and H.264

The test videos are H.264/AAC HLS, like production. Playwright's bundled Chromium cannot decode H.264. Use a real Chrome:

```bash
E2E_BROWSER_CHANNEL=chrome npx playwright test        # real decoding, used in CI
```

If only the bundled Chromium is available, set `E2E_FAKE_MEDIA=1`. A stand-in media element then keeps the playback clock
and still downloads the manifests and one segment per 4 s with the playback cookie, so billing, authorisation, the
segment budget and settlement are exercised for real; only pixel decoding is skipped. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
to point at a specific browser binary.
