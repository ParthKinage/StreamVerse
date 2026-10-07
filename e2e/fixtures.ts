import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { Contract, JsonRpcProvider, Network, Wallet, formatEther, parseEther } from 'ethers';
import { PAYMENT_ROUTER_ABI, STREAM_COIN_ABI } from '@tesor_gp/blockchain/abis';
import { makeClip, startStack, type Stack } from './stack';

/** True when the suite runs against built-in wallets (E2E_WALLET_MODE=managed) instead of linked browser wallets. */
export const MANAGED = process.env.E2E_WALLET_MODE === 'managed';

export interface Account {
  id: string;
  email: string;
  username: string;
  password: string;
  token: string;
  key: string;
  address: string;
}

export interface Catalog {
  creator: Account;
  mainVideoId: string;
  /** Rate per minute of the main video (each 4-second piece costs rate / 15). */
  mainRateWei: bigint;
  priceyVideoId: string;
  priceyRateWei: bigint;
  /** Duration of the seeded clips, used by the media stand-in. */
  clipSeconds: number;
}

export class Platform {
  readonly provider: JsonRpcProvider;
  readonly deployer: Wallet;
  private nextAccount = 20;
  nextAccountIndex(): number {
    return this.nextAccount++;
  }
  constructor(readonly stack: Stack) {
    this.provider = new JsonRpcProvider(stack.rpcUrl, 31337, { staticNetwork: Network.from(31337), cacheTimeout: -1, polling: true, pollingInterval: 100 });
    this.deployer = new Wallet(stack.chain.deployer.privateKey, this.provider);
  }

  router(signer: Wallet = this.deployer): Contract {
    return new Contract(this.stack.chain.paymentRouter, PAYMENT_ROUTER_ABI, signer);
  }
  coin(signer: Wallet = this.deployer): Contract {
    return new Contract(this.stack.chain.streamCoin, STREAM_COIN_ABI, signer);
  }
  wallet(key: string): Wallet {
    return new Wallet(key, this.provider);
  }

  async api<T = unknown>(pathname: string, init: { method?: string; token?: string; body?: unknown; form?: FormData } = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.stack.apiUrl}/api/v1${pathname}`, {
      method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
      headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.form ? { body: init.form } : init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }

  uniq(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  }

  /** Registers a user through the API. `link` signs the wallet-link message; STRM can be sent to the wallet. */
  async newAccount(options: { link?: boolean; strm?: string; prefix?: string } = {}): Promise<Account> {
    const username = this.uniq(options.prefix ?? 'user');
    const email = `${username}@e2e.test`;
    const password = 'Passw0rd!123';
    const reg = await this.api<{ accessToken: string; user: { id: string; walletAddress: string | null } }>('/auth/register', { body: { email, username, password } });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    if (MANAGED) {
      // Built-in wallets: the platform already made the wallet; there is no key to hold, nothing to link and no gas to fund.
      expect(reg.body.user.walletAddress, 'sign-up should return the built-in wallet').toMatch(/^0x[0-9a-f]{40}$/);
      return { id: reg.body.user.id, email, username, password, token: reg.body.accessToken, key: '', address: reg.body.user.walletAddress as string };
    }
    const key = this.stack.accountKey(this.nextAccount++);
    const w = this.wallet(key);
    const acct: Account = { id: reg.body.user.id, email, username, password, token: reg.body.accessToken, key, address: w.address };
    await this.fundGas(acct.address); // Hardhat only pre-funds its first 20 accounts
    if (options.link !== false) await this.linkWallet(acct);
    if (options.strm) await this.fundStrm(acct.address, options.strm);
    return acct;
  }

  async linkWallet(acct: Account): Promise<void> {
    const w = this.wallet(acct.key);
    const nonce = await this.api<{ message: string }>('/wallet/nonce', { token: acct.token, body: { address: w.address } });
    const signature = await w.signMessage(nonce.body.message);
    const link = await this.api('/wallet/link', { token: acct.token, body: { address: w.address, signature } });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
  }

  /** A dedicated account, so test funding never races the API relayer (which signs with the deployer key). */
  private get funder(): Wallet {
    return this.wallet(this.stack.accountKey(18));
  }
  private funderReady: Promise<void> | undefined;
  private ensureFunder(): Promise<void> {
    this.funderReady ??= (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await (await this.coin().getFunction('transfer')(this.funder.address, parseEther('1000000'))).wait();
          return;
        } catch (err) {
          if (attempt >= 5) throw err;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    })();
    return this.funderReady;
  }

  async fundStrm(address: string, strm: string): Promise<void> {
    await this.ensureFunder();
    await (await this.coin(this.funder).getFunction('transfer')(address, parseEther(strm))).wait();
  }

  /** Sends native gas token from the funder account. */
  async fundGas(address: string, amount = parseEther('1')): Promise<void> {
    await (await this.funder.sendTransaction({ to: address, value: amount })).wait();
  }

  /** Approves and deposits `strm` into escrow from the account's wallet, then waits until the API reflects it. */
  async deposit(acct: Account, strm: string): Promise<void> {
    const w = this.wallet(acct.key);
    const amount = parseEther(strm);
    const before = await this.summary(acct);
    await (await this.coin(w).getFunction('approve')(this.stack.chain.paymentRouter, amount)).wait();
    await (await this.router(w).getFunction('deposit')(amount)).wait();
    await expect.poll(async () => BigInt((await this.summary(acct)).escrowWei), { timeout: 30_000 }).toBeGreaterThanOrEqual(BigInt(before.escrowWei) + amount);
  }

  async summary(acct: Pick<Account, 'token'>): Promise<{ withdrawUnlockAt: string | null; escrowWei: string; availableWei: string; pendingWithdrawalWei: string; unsettledChargesWei: string; creatorEarningsWei: string }> {
    return (await this.api<{ withdrawUnlockAt: string | null; escrowWei: string; availableWei: string; pendingWithdrawalWei: string; unsettledChargesWei: string; creatorEarningsWei: string }>('/wallet/summary', { token: acct.token })).body;
  }

  async escrowOf(address: string): Promise<bigint> {
    return (await this.router().getFunction('escrow')(address)) as bigint;
  }
  async creatorEarningsOf(address: string): Promise<bigint> {
    return (await this.router().getFunction('creatorEarnings')(address)) as bigint;
  }
  async strmBalance(address: string): Promise<bigint> {
    return (await this.coin().getFunction('balanceOf')(address)) as bigint;
  }

  /** Plays `pieces` 4-second pieces of a video through the API exactly as a player does, then ends the session. */
  async watchViaApi(acct: Pick<Account, 'token'>, videoId: string, pieces: number): Promise<void> {
    const start = await fetch(`${this.stack.apiUrl}/api/v1/watch/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${acct.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId }),
    });
    const session = (await start.json()) as { sessionId: string; manifestUrl: string };
    expect(start.status, JSON.stringify(session)).toBe(201);
    const cookie = start.headers.getSetCookie().find((c) => c.startsWith('pbt='))!.split(';')[0]!;
    const master = await (await fetch(`${this.stack.apiUrl}${session.manifestUrl}`, { headers: { Cookie: cookie } })).text();
    const rendition = master.split(/\r?\n/).find((l) => l.endsWith('.m3u8'))!.split('/')[0]!;
    for (let i = 0; i < pieces; i++) {
      const piece = await fetch(`${this.stack.apiUrl}/playback/${session.sessionId}/${rendition}/seg_${String(i).padStart(3, '0')}.ts`, { headers: { Cookie: cookie } });
      expect(piece.status).toBe(200);
      await piece.arrayBuffer();
    }
    const end = await this.api(`/watch/sessions/${session.sessionId}/end`, { token: acct.token, body: {} });
    expect(end.status).toBe(200);
  }

  async makeCreator(acct: Account, channelName: string): Promise<void> {
    const r = await this.api('/creator/profile', { token: acct.token, body: { channelName } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }

  async uploadVideo(acct: Account, file: string, fields: { title: string; ratePerMinuteWei: string; category?: string }): Promise<string> {
    const form = new FormData();
    form.set('title', fields.title);
    form.set('description', 'End-to-end test video');
    form.set('category', fields.category ?? 'Education');
    form.set('ratePerMinuteWei', fields.ratePerMinuteWei);
    form.set('file', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
    const r = await this.api<{ id: string }>('/creator/videos', { token: acct.token, form });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id;
  }

  async waitForTranscode(acct: Account, videoId: string): Promise<void> {
    await expect
      .poll(
        async () => {
          const list = await this.api<{ items: Array<{ id: string; processingStatus: string; failureReason: string | null }> }>('/creator/videos', { token: acct.token });
          const v = list.body.items.find((i) => i.id === videoId);
          if (v?.processingStatus === 'FAILED') throw new Error(`transcoding failed: ${v.failureReason}`);
          return v?.processingStatus;
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe('COMPLETED');
  }

  async publish(acct: Account, videoId: string): Promise<void> {
    const r = await this.api(`/creator/videos/${videoId}/publish`, { token: acct.token, method: 'POST' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  /** Settlement rows for a user, newest first. */
  async settlements(userId: string): Promise<Array<{ id: string; status: string; amountSTRM: string; attempts: number; txHash: string | null }>> {
    return this.stack.pg('SELECT id, status, "amountSTRM"::text, attempts, "txHash" FROM "PaymentSettlement" WHERE "userId" = $1 ORDER BY "createdAt" DESC', [userId]);
  }
}

/** Stand-in for the media element when the test browser cannot decode H.264 (see README). */
function installFakeMedia(clipSeconds: number): void {
  const proto = HTMLMediaElement.prototype;
  type S = { playing: boolean; base: number; started: number; rate: number; timer: number | undefined; fetcher: number | undefined; src: string; segments: string[]; next: number; origin: string };
  const states = new WeakMap<HTMLMediaElement, S>();
  const st = (el: HTMLMediaElement): S => {
    let s = states.get(el);
    if (!s) {
      s = { playing: false, base: 0, started: 0, rate: 1, timer: undefined, fetcher: undefined, src: '', segments: [], next: 0, origin: '' };
      states.set(el, s);
    }
    return s;
  };
  const position = (el: HTMLMediaElement): number => {
    const s = st(el);
    return Math.min(clipSeconds, s.playing ? s.base + ((performance.now() - s.started) / 1000) * s.rate : s.base);
  };
  const define = (name: string, descriptor: PropertyDescriptor): void => {
    Object.defineProperty(proto, name, { configurable: true, ...descriptor });
  };
  define('paused', { get(this: HTMLMediaElement) { return !st(this).playing; } });
  define('ended', { get() { return false; } });
  define('readyState', { get() { return 4; } });
  define('duration', { get() { return clipSeconds; } });
  define('playbackRate', {
    get(this: HTMLMediaElement) { return st(this).rate; },
    set(this: HTMLMediaElement, v: number) { const s = st(this); s.base = position(this); s.started = performance.now(); s.rate = v; },
  });
  define('currentTime', {
    get(this: HTMLMediaElement) { return position(this); },
    set(this: HTMLMediaElement, v: number) { const s = st(this); s.base = Number(v); s.started = performance.now(); this.dispatchEvent(new Event('seeked')); },
  });
  proto.canPlayType = (type: string): CanPlayTypeResult => (/mpegurl/i.test(type) ? 'maybe' : '');
  proto.load = () => undefined;
  define('src', {
    get(this: HTMLMediaElement) { return st(this).src; },
    set(this: HTMLMediaElement, value: string) {
      const s = st(this);
      s.src = value;
      s.segments = [];
      s.next = 0;
      // Fetch the manifests with the playback cookie, like a real player would, then report metadata.
      void (async () => {
        try {
          const master = await (await fetch(value, { credentials: 'include' })).text();
          const rendition = master.split('\n').find((l) => l.endsWith('.m3u8'));
          if (rendition) {
            const base = value.slice(0, value.lastIndexOf('/') + 1);
            const playlist = await (await fetch(base + rendition, { credentials: 'include' })).text();
            const dir = base + rendition.slice(0, rendition.lastIndexOf('/') + 1);
            s.segments = playlist.split('\n').filter((l) => l.endsWith('.ts')).map((l) => dir + l);
          }
        } catch {
          // The page surfaces its own errors.
        }
        this.dispatchEvent(new Event('loadedmetadata'));
      })();
    },
  });
  proto.play = function (this: HTMLMediaElement): Promise<void> {
    const s = st(this);
    if (!s.playing) {
      s.base = position(this);
      s.started = performance.now();
      s.playing = true;
      s.timer = window.setInterval(() => this.dispatchEvent(new Event('timeupdate')), 250);
      // One segment every 4 s of playback, so the playback authorisation and segment budget are exercised for real.
      s.fetcher = window.setInterval(() => {
        const url = s.segments[s.next % Math.max(1, s.segments.length)];
        if (url) {
          s.next += 1;
          void fetch(url, { credentials: 'include' }).catch(() => undefined);
        }
      }, 4000);
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
    }
    return Promise.resolve();
  };
  proto.pause = function (this: HTMLMediaElement): void {
    const s = st(this);
    if (s.playing) {
      s.base = position(this);
      s.playing = false;
      window.clearInterval(s.timer);
      window.clearInterval(s.fetcher);
      this.dispatchEvent(new Event('pause'));
    }
  };
  // hls.js is only usable when MediaSource supports the codecs; the stand-in plays through the native HLS branch.
  Object.defineProperty(window, 'MediaSource', { configurable: true, value: undefined });
  Object.defineProperty(window, 'ManagedMediaSource', { configurable: true, value: undefined });
}

export interface PageHelpers {
  /** Gives the page a browser wallet backed by `key` (must be called before the first navigation). */
  withWallet(page: Page, key: string): Promise<void>;
  login(page: Page, acct: Account): Promise<void>;
  watchedSeconds(page: Page): Promise<number>;
  /** Presses Play on a watch page. Viewers pay per second as the video plays; there is nothing to buy first. */
  play(page: Page): Promise<void>;
}

export const test = base.extend<{ platform: Platform; catalog: Catalog; helpers: PageHelpers; modeGuard: void }, { stack: Stack; platformW: Platform; catalogW: Catalog }>({
  // Each run uses one wallet mode: built-in wallet scenarios only run with E2E_WALLET_MODE=managed, the rest without it.
  modeGuard: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      const forManaged = /built-in/.test(testInfo.file);
      testInfo.skip(forManaged !== MANAGED, forManaged ? 'needs E2E_WALLET_MODE=managed' : 'not for E2E_WALLET_MODE=managed');
      await use();
    },
    { auto: true },
  ],
  stack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const stack = await startStack();
      try {
        await use(stack);
      } finally {
        await stack.stop();
      }
    },
    { scope: 'worker', timeout: 300_000 },
  ],
  platformW: [
    async ({ stack }, use) => {
      const p = new Platform(stack);
      await use(p);
      p.provider.destroy();
    },
    { scope: 'worker' },
  ],
  catalogW: [
    async ({ platformW: p }, use) => {
      const clipSeconds = 100;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamverse-e2e-media-'));
      const clip = path.join(dir, 'clip.mp4');
      makeClip(clip, clipSeconds);
      const creator = await p.newAccount({ prefix: 'creator' });
      await p.makeCreator(creator, 'E2E Channel');
      // Rates that split evenly into 4-second pieces: 0.2 and 0.4 STRM per piece (5 and 10 for the whole 100 s).
      const mainRateWei = parseEther('3');
      const priceyRateWei = parseEther('6');
      const mainVideoId = await p.uploadVideo(creator, clip, { title: 'E2E main video', ratePerMinuteWei: mainRateWei.toString() });
      const priceyVideoId = await p.uploadVideo(creator, clip, { title: 'E2E premium video', ratePerMinuteWei: priceyRateWei.toString() });
      await p.waitForTranscode(creator, mainVideoId);
      await p.waitForTranscode(creator, priceyVideoId);
      await p.publish(creator, mainVideoId);
      await p.publish(creator, priceyVideoId);
      fs.rmSync(dir, { recursive: true, force: true });
      await use({ creator, mainVideoId, mainRateWei, priceyVideoId, priceyRateWei, clipSeconds });
    },
    { scope: 'worker', timeout: 300_000 },
  ],
  platform: async ({ platformW }, use) => use(platformW),
  catalog: async ({ catalogW }, use) => use(catalogW),
  baseURL: async ({ stack }, use) => use(stack.webUrl),
  helpers: async ({ stack, catalog }, use) => {
    const useFake = process.env.E2E_FAKE_MEDIA === '1';
    await use({
      async withWallet(page, key) {
        await page.addInitScript(
          ({ privateKey, rpcUrl }) => {
            (window as unknown as { __E2E_WALLET__: unknown }).__E2E_WALLET__ = { privateKey, rpcUrl, chainId: 31337 };
          },
          { privateKey: key, rpcUrl: stack.rpcUrl },
        );
        if (useFake) await page.addInitScript(installFakeMedia, catalog.clipSeconds);
      },
      async login(page, acct) {
        await page.goto('/login');
        await page.getByLabel('Email').fill(acct.email);
        await page.getByLabel('Password').fill(acct.password);
        await page.getByRole('button', { name: 'Log in' }).click();
        await expect(page.getByRole('link', { name: acct.username })).toBeVisible();
      },
      async play(page) {
        await page.getByTestId('start-playback').click();
        await expect(page.getByTestId('cost-meter')).toBeVisible({ timeout: 30_000 });
      },
      async watchedSeconds(page) {
        const text = (await page.getByTestId('meter-time').textContent()) ?? '0:00';
        const parts = text.split(':').map(Number);
        return parts.reduce((acc, n) => acc * 60 + n, 0);
      },
    });
  },
});

export { expect, formatEther, parseEther };
