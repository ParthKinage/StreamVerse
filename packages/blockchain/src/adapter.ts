import {
  Contract,
  FeeData,
  Interface,
  JsonRpcProvider,
  Network,
  Wallet,
  type ContractTransactionReceipt,
  type EventLog,
  type Log,
} from 'ethers';
import { PAYMENT_ROUTER_ABI, STREAM_COIN_ABI } from './abis';
import { InsufficientGas, Reverted, RpcUnavailable } from './errors';
import { Mutex } from './mutex';

export interface AdapterConfig {
  rpcUrl: string;
  chainId: number;
  streamCoinAddress: string;
  paymentRouterAddress: string;
  /** Server-only. Never pass this from browser code. */
  relayerPrivateKey?: string;
  confirmations?: number;
  /** Per-call timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Extra attempts for reads and idempotent writes (default 2). */
  retries?: number;
  retryBaseDelayMs?: number;
  /**
   * Fee ceiling above the current base fee, in percent (default 25). ethers offers up to 2 x base fee + tip, and the
   * node refuses a transaction unless the relayer holds gas limit x that ceiling, so a lower ceiling lets a lightly
   * funded relayer keep working. The fee actually paid is base fee + tip either way.
   */
  feeHeadroomPct?: number;
}

/** Replaces ethers' fee ceiling (2 x base fee + tip) with base fee x (1 + headroom) + tip. Legacy chains are untouched. */
export function cappedFeeData(fee: FeeData, headroomPct: number): FeeData {
  if (fee.maxFeePerGas == null || fee.maxPriorityFeePerGas == null) return fee;
  const base = (fee.maxFeePerGas - fee.maxPriorityFeePerGas) / 2n;
  const maxFeePerGas = base + (base * BigInt(headroomPct)) / 100n + fee.maxPriorityFeePerGas;
  return new FeeData(fee.gasPrice, maxFeePerGas, fee.maxPriorityFeePerGas);
}

/** The relayer's provider: every transaction it signs gets the lower fee ceiling. */
class CappedFeeProvider extends JsonRpcProvider {
  constructor(
    url: string,
    network: Network,
    options: ConstructorParameters<typeof JsonRpcProvider>[2],
    private readonly headroomPct: number,
  ) {
    super(url, network, options);
  }

  override async getFeeData(): Promise<FeeData> {
    return cappedFeeData(await super.getFeeData(), this.headroomPct);
  }
}

export interface SettlementItem {
  /** bytes32 hex id (the settlementKey). */
  id: string;
  viewer: string;
  creator: string;
  amount: bigint;
}

/** One coin credit to a viewer's escrow (a top-up or a bonus). `id` makes it impossible to credit twice. */
export interface CreditItem {
  /** bytes32 hex id. */
  id: string;
  viewer: string;
  amount: bigint;
}

export interface EscrowState {
  escrow: bigint;
  pendingWithdrawal: bigint;
  withdrawUnlockAt: bigint;
}

export interface TxResult {
  txHash: string;
  blockNumber: number;
}

export interface ParsedChainLog {
  name: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Lower-cased address the event is about (viewer, or creator for earnings events). */
  address: string | null;
  args: Record<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ERROR_INTERFACE = new Interface([...PAYMENT_ROUTER_ABI, ...STREAM_COIN_ABI.filter((f) => f.type === 'error')]);

/** Finds revert data (0x...) anywhere on an ethers error and decodes it with the contract error ABI. */
function decodeRevert(err: unknown): { name: string; args: readonly unknown[] } | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const data = (cur as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) {
      try {
        const parsed = ERROR_INTERFACE.parseError(data);
        if (parsed) return { name: parsed.name, args: [...parsed.args] };
      } catch {
        // not a known error selector
      }
    }
    for (const key of ['error', 'info', 'cause', 'data']) queue.push((cur as Record<string, unknown>)[key]);
  }
  return undefined;
}

/** All message strings found on an error and its nested error/info/cause objects. */
function allMessages(err: unknown): string {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const message = (cur as { message?: unknown }).message;
    if (typeof message === 'string') out.push(message);
    for (const key of ['error', 'info', 'cause']) queue.push((cur as Record<string, unknown>)[key]);
  }
  return out.join(' | ');
}

function errorCode(err: unknown): string {
  return String((err as { code?: unknown })?.code ?? '');
}

/** Maps ethers/RPC failures to the typed errors of this package. */
export function mapChainError(err: unknown): Error {
  if (err instanceof RpcUnavailable || err instanceof Reverted || err instanceof InsufficientGas) return err;
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'INSUFFICIENT_FUNDS' || /insufficient funds|doesn't have enough funds|not enough funds/i.test(allMessages(err))) {
    return new InsufficientGas('Relayer account has insufficient gas funds', { cause: err });
  }
  if (code === 'CALL_EXCEPTION' || code === 'ACTION_REJECTED' || /revert/i.test(message)) {
    const e = err as { revert?: { name?: string; args?: readonly unknown[] }; reason?: string };
    const decoded = decodeRevert(err);
    const reason = decoded?.name ?? e.revert?.name ?? e.reason ?? undefined;
    return new Reverted(`Transaction reverted${reason ? `: ${reason}` : ''}`, reason, decoded?.args ?? e.revert?.args, { cause: err });
  }
  if (code === 'NONCE_EXPIRED' || code === 'REPLACEMENT_UNDERPRICED') {
    return new RpcUnavailable(`Nonce conflict: ${message}`, { cause: err });
  }
  return new RpcUnavailable(`RPC unavailable: ${message}`, { cause: err });
}

export class ChainAdapter {
  readonly provider: JsonRpcProvider;
  readonly config: Required<Pick<AdapterConfig, 'confirmations' | 'timeoutMs' | 'retries' | 'retryBaseDelayMs'>> & AdapterConfig;
  readonly relayerAddress: string | undefined;
  private readonly wallet: Wallet | undefined;
  private readonly router: Contract;
  private readonly routerRead: Contract;
  private readonly token: Contract;
  private readonly tokenRead: Contract;
  private readonly mutex = new Mutex();

  constructor(config: AdapterConfig) {
    this.config = { confirmations: 1, timeoutMs: 10_000, retries: 2, retryBaseDelayMs: 250, ...config };
    const network = Network.from(config.chainId);
    this.provider = new CappedFeeProvider(
      config.rpcUrl,
      network,
      { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1, polling: true, pollingInterval: 250 },
      config.feeHeadroomPct ?? 25,
    );
    this.routerRead = new Contract(config.paymentRouterAddress, PAYMENT_ROUTER_ABI, this.provider);
    this.tokenRead = new Contract(config.streamCoinAddress, STREAM_COIN_ABI, this.provider);
    if (config.relayerPrivateKey) {
      this.wallet = new Wallet(config.relayerPrivateKey, this.provider);
      this.relayerAddress = this.wallet.address;
      this.router = new Contract(config.paymentRouterAddress, PAYMENT_ROUTER_ABI, this.wallet);
      this.token = new Contract(config.streamCoinAddress, STREAM_COIN_ABI, this.wallet);
    } else {
      this.router = this.routerRead;
      this.token = this.tokenRead;
    }
  }

  destroy(): void {
    this.provider.destroy();
  }

  // ------------------------------------------------------------------ helpers

  private async withTimeout<T>(op: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RpcUnavailable(`RPC call timed out after ${this.config.timeoutMs}ms`)),
        this.config.timeoutMs,
      );
    });
    try {
      return await Promise.race([op(), timeout]);
    } catch (err) {
      throw mapChainError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Runs `op` with a timeout, retrying RpcUnavailable failures with exponential backoff. */
  private async call<T>(op: () => Promise<T>, retries = this.config.retries): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.withTimeout(op);
      } catch (err) {
        if (!(err instanceof RpcUnavailable) || attempt >= retries) throw err;
        await sleep(this.config.retryBaseDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  private requireRelayer(): void {
    if (!this.wallet) throw new Error('This adapter has no relayer key configured (read-only)');
  }

  // -------------------------------------------------------------------- reads

  getBlockNumber(): Promise<number> {
    return this.call(() => this.provider.getBlockNumber());
  }

  async getEscrow(viewer: string): Promise<EscrowState> {
    return this.call(async () => {
      const [escrow, pendingWithdrawal, withdrawUnlockAt] = await Promise.all([
        this.routerRead.getFunction('escrow')(viewer) as Promise<bigint>,
        this.routerRead.getFunction('pendingWithdrawal')(viewer) as Promise<bigint>,
        this.routerRead.getFunction('withdrawUnlockAt')(viewer) as Promise<bigint>,
      ]);
      return { escrow, pendingWithdrawal, withdrawUnlockAt };
    });
  }

  getCreatorEarnings(creator: string): Promise<bigint> {
    return this.call(() => this.routerRead.getFunction('creatorEarnings')(creator) as Promise<bigint>);
  }

  getPlatformEarnings(): Promise<bigint> {
    return this.call(() => this.routerRead.getFunction('platformEarnings')() as Promise<bigint>);
  }

  getTokenBalance(account: string): Promise<bigint> {
    return this.call(() => this.tokenRead.getFunction('balanceOf')(account) as Promise<bigint>);
  }

  getFeeBps(): Promise<number> {
    return this.call(async () => Number(await this.routerRead.getFunction('feeBps')()));
  }

  getWithdrawDelay(): Promise<number> {
    return this.call(async () => Number(await this.routerRead.getFunction('withdrawDelay')()));
  }

  isSettled(id: string): Promise<boolean> {
    return this.call(() => this.routerRead.getFunction('settled')(id) as Promise<boolean>);
  }

  /** Returns, for each id, whether it is already settled on-chain. */
  async areSettled(ids: string[]): Promise<boolean[]> {
    return Promise.all(ids.map((id) => this.isSettled(id)));
  }

  isCredited(id: string): Promise<boolean> {
    return this.call(() => this.routerRead.getFunction('credited')(id) as Promise<boolean>);
  }

  /** Returns, for each id, whether it has already been credited on-chain. */
  async areCredited(ids: string[]): Promise<boolean[]> {
    return Promise.all(ids.map((id) => this.isCredited(id)));
  }

  getTimestamp(blockNumber: number): Promise<number> {
    return this.call(async () => {
      const block = await this.provider.getBlock(blockNumber);
      if (!block) throw new RpcUnavailable(`Block ${blockNumber} not found`);
      return block.timestamp;
    });
  }

  /** Parsed PaymentRouter logs in [fromBlock, toBlock], ordered by block and log index. */
  async getLogs(fromBlock: number, toBlock: number): Promise<ParsedChainLog[]> {
    const logs = await this.call(() =>
      this.provider.getLogs({ address: this.config.paymentRouterAddress, fromBlock, toBlock }),
    );
    const parsed: ParsedChainLog[] = [];
    for (const log of logs as Log[]) {
      const desc = this.routerRead.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (!desc) continue;
      const args: Record<string, string> = {};
      desc.fragment.inputs.forEach((input, i) => {
        args[input.name] = String(desc.args[i]);
      });
      const subject = args.viewer ?? args.creator ?? args.to ?? null;
      parsed.push({
        name: desc.name,
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        address: subject ? subject.toLowerCase() : null,
        args,
      });
    }
    parsed.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return parsed;
  }

  // ------------------------------------------------------------------- writes

  private async send(
    build: () => Promise<{ hash: string; wait: (confirms?: number) => Promise<ContractTransactionReceipt | null> }>,
  ): Promise<TxResult> {
    this.requireRelayer();
    return this.mutex.run(async () => {
      const tx = await this.withTimeout(build);
      const receipt = await this.withTimeout(() => tx.wait(this.config.confirmations));
      if (!receipt || receipt.status !== 1) throw new Reverted('Transaction failed on-chain');
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
    });
  }

  /** Sends one settleBatch transaction. Retried on RPC failure; ids are unique on-chain so retries cannot double-charge. */
  async settleBatch(items: SettlementItem[]): Promise<TxResult> {
    this.requireRelayer();
    let attempt = 0;
    for (;;) {
      try {
        return await this.send(() => this.router.getFunction('settleBatch')(items.map(toTuple)));
      } catch (err) {
        if (!(err instanceof RpcUnavailable) || attempt >= this.config.retries) throw err;
        await sleep(this.config.retryBaseDelayMs * 2 ** attempt);
        attempt += 1;
        // The previous attempt may have been mined before the connection dropped; if every id is settled we are done.
        try {
          const done = await this.areSettled(items.map((i) => i.id));
          if (done.every(Boolean)) {
            const first = items[0];
            const found = first ? await this.findSettlementTx(first.id, 0) : null;
            if (found) return found;
          }
        } catch {
          // still unreachable: fall through to the next attempt
        }
      }
    }
  }

  /** Finds the transaction that settled `id` (scans Settled logs from `fromBlock`). */
  async findSettlementTx(id: string, fromBlock: number): Promise<TxResult | null> {
    const logs = await this.call(() =>
      this.routerRead.queryFilter(this.routerRead.filters.Settled?.(id) ?? 'Settled', fromBlock, 'latest'),
    );
    const log = logs[0] as EventLog | undefined;
    return log ? { txHash: log.transactionHash, blockNumber: log.blockNumber } : null;
  }

  /** Dry-runs a batch so callers can find items that would revert. Throws Reverted with the custom error name. */
  async simulateSettleBatch(items: SettlementItem[]): Promise<void> {
    this.requireRelayer();
    await this.call(
      () => this.router.getFunction('settleBatch').staticCall(items.map(toTuple)),
      this.config.retries,
    );
  }

  /**
   * Credits several viewers' escrow in one transaction from the relayer's own token balance (coins bought, bonuses).
   * Retried on RPC failure; ids are unique on-chain so a retry can never credit twice.
   */
  async creditBatch(items: CreditItem[]): Promise<TxResult> {
    this.requireRelayer();
    await this.ensureRouterAllowance(items.reduce((sum, i) => sum + i.amount, 0n));
    let attempt = 0;
    for (;;) {
      try {
        return await this.send(() => this.router.getFunction('creditBatch')(items.map(toCreditTuple)));
      } catch (err) {
        if (!(err instanceof RpcUnavailable) || attempt >= this.config.retries) throw err;
        await sleep(this.config.retryBaseDelayMs * 2 ** attempt);
        attempt += 1;
        try {
          const done = await this.areCredited(items.map((i) => i.id));
          if (done.every(Boolean)) {
            const first = items[0];
            const found = first ? await this.findCreditTx(first.id, 0) : null;
            if (found) return found;
          }
        } catch {
          // still unreachable: fall through to the next attempt
        }
      }
    }
  }

  /** Dry-runs a credit batch. Throws Reverted with the custom error name. */
  async simulateCreditBatch(items: CreditItem[]): Promise<void> {
    this.requireRelayer();
    await this.call(() => this.router.getFunction('creditBatch').staticCall(items.map(toCreditTuple)), this.config.retries);
  }

  /** Finds the transaction that credited `id` (scans Credited logs from `fromBlock`). */
  async findCreditTx(id: string, fromBlock: number): Promise<TxResult | null> {
    const logs = await this.call(() =>
      this.routerRead.queryFilter(this.routerRead.filters.Credited?.(id) ?? 'Credited', fromBlock, 'latest'),
    );
    const log = logs[0] as EventLog | undefined;
    return log ? { txHash: log.transactionHash, blockNumber: log.blockNumber } : null;
  }

  /** Pays a creator's earnings to the creator's own address; the relayer only pays the gas. */
  async claimEarningsFor(creator: string): Promise<TxResult> {
    this.requireRelayer();
    return this.send(() => this.router.getFunction('claimEarningsFor')(creator));
  }

  /** Credits `viewer`'s escrow from the relayer's own token balance (welcome bonus). Not retried automatically. */
  async depositFor(viewer: string, amount: bigint): Promise<TxResult> {
    this.requireRelayer();
    await this.ensureRouterAllowance(amount);
    return this.send(() => this.router.getFunction('depositFor')(viewer, amount));
  }

  /** Approves the router for the relayer's tokens when the allowance is too small. */
  async ensureRouterAllowance(minimum: bigint): Promise<void> {
    this.requireRelayer();
    const allowance = (await this.call(() =>
      this.tokenRead.getFunction('allowance')(this.relayerAddress, this.config.paymentRouterAddress),
    )) as bigint;
    if (allowance >= minimum) return;
    await this.send(() =>
      this.token.getFunction('approve')(this.config.paymentRouterAddress, 2n ** 255n),
    );
  }

  /** Returns the relayer's native (gas) balance. */
  getRelayerGasBalance(): Promise<bigint> {
    this.requireRelayer();
    return this.call(() => this.provider.getBalance(this.relayerAddress as string));
  }
}

function toTuple(i: SettlementItem): { id: string; viewer: string; creator: string; amount: bigint } {
  return { id: i.id, viewer: i.viewer, creator: i.creator, amount: i.amount };
}

function toCreditTuple(i: CreditItem): { id: string; viewer: string; amount: bigint } {
  return { id: i.id, viewer: i.viewer, amount: i.amount };
}

export type { EventLog };
