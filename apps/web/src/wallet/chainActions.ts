import { BrowserProvider, Contract, parseUnits, type ContractTransactionResponse, type Signer } from 'ethers';
import { PAYMENT_ROUTER_ABI, STREAM_COIN_ABI } from '@tesor_gp/blockchain/abis';
import type { ConfigResponse } from '@tesor_gp/shared';
import { getProvider, isUnrecognizedChain, type Eip1193Provider } from './eip1193';

export async function requireProvider(): Promise<Eip1193Provider> {
  const p = await getProvider();
  if (!p) throw new Error('No wallet found');
  return p;
}

export async function getSigner(): Promise<Signer> {
  const provider = new BrowserProvider(await requireProvider());
  return provider.getSigner();
}

export async function readChainId(provider: Eip1193Provider): Promise<number> {
  return Number.parseInt(String(await provider.request({ method: 'eth_chainId' })), 16);
}

/** Switches to the app's network, adding it to the wallet first if it is unknown. */
export async function switchToAppNetwork(cfg: Pick<ConfigResponse, 'chainId' | 'chainName' | 'rpcUrl' | 'explorerUrl'>): Promise<void> {
  const provider = await requireProvider();
  const chainId = `0x${cfg.chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (err) {
    if (!isUnrecognizedChain(err)) throw err;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: cfg.chainName,
          rpcUrls: [cfg.rpcUrl],
          nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
          blockExplorerUrls: cfg.explorerUrl ? [cfg.explorerUrl] : [],
        },
      ],
    });
  }
}

export function parseAmount(input: string): { wei: bigint } | { error: string } {
  const v = input.trim();
  if (v === '') return { error: 'Enter an amount' };
  if (!/^\d+(\.\d{1,18})?$/.test(v)) return { error: 'Use a positive number with up to 18 decimals' };
  const wei = parseUnits(v, 18);
  if (wei === 0n) return { error: 'Amount must be greater than zero' };
  return { wei };
}

export type TopUpStep = 'signing' | 'permit-fallback-approve' | 'depositing';
export interface TopUpHooks {
  onStep(step: TopUpStep): void;
  onTx(hash: string): void;
}

function contracts(cfg: ConfigResponse, signer: Signer): { token: Contract; router: Contract } {
  if (!cfg.streamCoinAddress || !cfg.paymentRouterAddress) throw new Error('Contracts are not configured on the server');
  return { token: new Contract(cfg.streamCoinAddress, STREAM_COIN_ABI, signer), router: new Contract(cfg.paymentRouterAddress, PAYMENT_ROUTER_ABI, signer) };
}

export async function tokenBalance(cfg: ConfigResponse, signer: Signer): Promise<bigint> {
  const { token } = contracts(cfg, signer);
  return (await token.getFunction('balanceOf')(await signer.getAddress())) as bigint;
}

export async function gasBalance(signer: Signer): Promise<bigint> {
  const provider = signer.provider;
  if (!provider) return 0n;
  return provider.getBalance(await signer.getAddress());
}

async function wait(tx: ContractTransactionResponse): Promise<void> {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('The transaction failed on-chain');
}

/**
 * Preferred path: sign an EIP-2612 permit and deposit in a single transaction.
 * If signing typed data is unsupported or fails (not rejected), fall back to approve + deposit.
 */
export async function topUp(cfg: ConfigResponse, amountWei: bigint, hooks: TopUpHooks, isRejected: (e: unknown) => boolean): Promise<void> {
  const signer = await getSigner();
  const { token, router } = contracts(cfg, signer);
  const owner = await signer.getAddress();
  const balance = (await token.getFunction('balanceOf')(owner)) as bigint;
  if (balance < amountWei) throw new Error('Your wallet does not hold enough STRM for this amount');

  try {
    hooks.onStep('signing');
    const nonce = (await token.getFunction('nonces')(owner)) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const tokenName = (await token.getFunction('name')()) as string;
    const signature = await signer.signTypedData(
      { name: tokenName, version: '1', chainId: cfg.chainId, verifyingContract: cfg.streamCoinAddress as string },
      { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      { owner, spender: cfg.paymentRouterAddress, value: amountWei, nonce, deadline },
    );
    const { v, r, s } = splitSignature(signature);
    hooks.onStep('depositing');
    const tx = (await router.getFunction('depositWithPermit')(amountWei, deadline, v, r, s)) as ContractTransactionResponse;
    hooks.onTx(tx.hash);
    await wait(tx);
    return;
  } catch (err) {
    if (isRejected(err)) throw err;
    // Not a rejection: the wallet cannot sign typed data (or the permit path reverted). Use approve + deposit.
  }

  hooks.onStep('permit-fallback-approve');
  const allowance = (await token.getFunction('allowance')(owner, cfg.paymentRouterAddress)) as bigint;
  if (allowance < amountWei) {
    const approve = (await token.getFunction('approve')(cfg.paymentRouterAddress, amountWei)) as ContractTransactionResponse;
    hooks.onTx(approve.hash);
    await wait(approve);
  }
  hooks.onStep('depositing');
  const dep = (await router.getFunction('deposit')(amountWei)) as ContractTransactionResponse;
  hooks.onTx(dep.hash);
  await wait(dep);
}

function splitSignature(sig: string): { v: number; r: string; s: string } {
  const hex = sig.startsWith('0x') ? sig.slice(2) : sig;
  const v = Number.parseInt(hex.slice(128, 130), 16);
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v: v < 27 ? v + 27 : v };
}

export type RouterAction = 'requestWithdraw' | 'cancelWithdraw' | 'executeWithdraw' | 'claimEarnings';
export async function routerCall(cfg: ConfigResponse, action: RouterAction, onTx: (hash: string) => void, amountWei?: bigint): Promise<void> {
  const signer = await getSigner();
  const { router } = contracts(cfg, signer);
  const fn = router.getFunction(action);
  const tx = (action === 'requestWithdraw' ? await fn(amountWei ?? 0n) : await fn()) as ContractTransactionResponse;
  onTx(tx.hash);
  await wait(tx);
}

