/**
 * Test helpers: start a local Hardhat node, deploy the contracts and optionally put a switchable proxy in front of it
 * to simulate RPC outages. Used by integration tests in this package, apps/api and e2e. Not for production code.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { ContractFactory, JsonRpcProvider, Network, Wallet, HDNodeWallet, Mnemonic, parseEther } from 'ethers';
import { repoRoot } from './deployments';

export const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

/** Hardhat's well-known development accounts (derived from the public test mnemonic). */
export function hardhatAccount(index: number): HDNodeWallet {
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_MNEMONIC), `m/44'/60'/0'/0/${index}`);
}

export interface LocalChain {
  rpcUrl: string;
  chainId: number;
  streamCoin: string;
  paymentRouter: string;
  deploymentBlock: number;
  deployer: Wallet;
  feeBps: number;
  withdrawDelaySec: number;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function readArtifact(root: string, name: string): { abi: unknown[]; bytecode: string } {
  const file = path.join(root, 'contracts', 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { abi: unknown[]; bytecode: string };
}

function hardhatBin(root: string): string {
  return require.resolve('hardhat/internal/cli/bootstrap.js', { paths: [path.join(root, 'contracts')] });
}

export function ensureCompiled(): void {
  const root = repoRoot();
  const marker = path.join(root, 'contracts', 'artifacts', 'contracts', 'PaymentRouter.sol', 'PaymentRouter.json');
  if (fs.existsSync(marker)) return;
  const res = spawnSync(process.execPath, [hardhatBin(root), 'compile'], { cwd: path.join(root, 'contracts'), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`hardhat compile failed:\n${res.stdout}\n${res.stderr}`);
}

async function waitForRpc(url: string, child: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error('hardhat node exited early');
    try {
      const provider = new JsonRpcProvider(url, 31337, { staticNetwork: Network.from(31337), cacheTimeout: -1 });
      await provider.getBlockNumber();
      provider.destroy();
      return;
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for hardhat node');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Starts `hardhat node` on a free port, deploys StreamCoin + PaymentRouter and grants SETTLER_ROLE to account #0. */
export async function startLocalChain(options: { feeBps?: number; withdrawDelaySec?: number; initialSupply?: bigint } = {}): Promise<LocalChain> {
  const root = repoRoot();
  ensureCompiled();
  const port = await freePort();
  const child = spawn(process.execPath, [hardhatBin(root), 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'contracts'),
    stdio: 'ignore',
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };
  try {
    await waitForRpc(rpcUrl, child);
    const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: Network.from(31337), cacheTimeout: -1, polling: true, pollingInterval: 100 });
    const deployer = new Wallet(hardhatAccount(0).privateKey, provider);
    const feeBps = options.feeBps ?? 1000;
    const withdrawDelaySec = options.withdrawDelaySec ?? 900;
    const coinArtifact = readArtifact(root, 'StreamCoin');
    const routerArtifact = readArtifact(root, 'PaymentRouter');
    const coin = await new ContractFactory(coinArtifact.abi as never, coinArtifact.bytecode, deployer).deploy(options.initialSupply ?? 100_000_000n);
    await coin.waitForDeployment();
    const router = await new ContractFactory(routerArtifact.abi as never, routerArtifact.bytecode, deployer).deploy(
      await coin.getAddress(),
      deployer.address,
      feeBps,
      withdrawDelaySec,
    );
    const receipt = await router.deploymentTransaction()?.wait();
    await router.waitForDeployment();
    const grant = await (router as unknown as { grantRole: (r: string, a: string) => Promise<{ wait: () => Promise<unknown> }> }).grantRole(
      await (router as unknown as { SETTLER_ROLE: () => Promise<string> }).SETTLER_ROLE(),
      deployer.address,
    );
    await grant.wait();
    provider.destroy();
    return {
      rpcUrl,
      chainId: 31337,
      streamCoin: await coin.getAddress(),
      paymentRouter: await router.getAddress(),
      deploymentBlock: receipt?.blockNumber ?? 0,
      deployer,
      feeBps,
      withdrawDelaySec,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Funds an address with STRM from the deployer (test setup helper). */
export async function fundWithStrm(chain: LocalChain, to: string, amountStrm: string): Promise<void> {
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: Network.from(31337), cacheTimeout: -1, polling: true, pollingInterval: 100 });
  const signer = new Wallet(chain.deployer.privateKey, provider);
  const coinArtifact = readArtifact(repoRoot(), 'StreamCoin');
  const coin = new ContractFactory(coinArtifact.abi as never, coinArtifact.bytecode, signer).attach(chain.streamCoin);
  const tx = await (coin as unknown as { transfer: (to: string, v: bigint) => Promise<{ wait: () => Promise<unknown> }> }).transfer(to, parseEther(amountStrm));
  await tx.wait();
  provider.destroy();
}

/** HTTP proxy in front of a JSON-RPC endpoint that can be switched "down" to simulate an outage. */
export class FlakyRpcProxy {
  private server: http.Server | undefined;
  down = false;
  url = '';

  constructor(private readonly target: string) {}

  async start(): Promise<string> {
    const port = await freePort();
    const targetUrl = new URL(this.target);
    this.server = http.createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      const upstream = http.request(
        { host: targetUrl.hostname, port: targetUrl.port, path: req.url, method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => req.socket.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}
