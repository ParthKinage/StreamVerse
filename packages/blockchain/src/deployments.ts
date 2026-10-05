import fs from 'node:fs';
import path from 'node:path';

export interface Deployment {
  chainId: number;
  streamCoin: string;
  paymentRouter: string;
  deploymentBlock: number;
  deployer?: string;
  relayer?: string;
  feeBps?: number;
  withdrawDelaySec?: number;
}

function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'contracts', 'hardhat.config.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function repoRoot(): string {
  const root = findRepoRoot(process.cwd()) ?? findRepoRoot(__dirname);
  if (!root) throw new Error('Could not locate the repository root (contracts/hardhat.config.js)');
  return root;
}

/**
 * Loads contract addresses for a chain. Environment variables STREAMCOIN_TOKEN_ADDRESS / PAYMENT_ROUTER_ADDRESS
 * take precedence over contracts/deployments/<chainId>.json. Returns undefined when neither source has them.
 */
export function loadDeployment(
  chainId: number,
  env: { STREAMCOIN_TOKEN_ADDRESS?: string; PAYMENT_ROUTER_ADDRESS?: string; DEPLOYMENT_BLOCK?: string } = process.env,
): Deployment | undefined {
  let file: Partial<Deployment> = {};
  try {
    const p = path.join(repoRoot(), 'contracts', 'deployments', `${chainId}.json`);
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')) as Deployment;
  } catch {
    // no readable deployment file; rely on env
  }
  const streamCoin = env.STREAMCOIN_TOKEN_ADDRESS || file.streamCoin;
  const paymentRouter = env.PAYMENT_ROUTER_ADDRESS || file.paymentRouter;
  if (!streamCoin || !paymentRouter) return undefined;
  const envBlock = env.DEPLOYMENT_BLOCK ? Number(env.DEPLOYMENT_BLOCK) : undefined;
  return { ...file, chainId, streamCoin, paymentRouter, deploymentBlock: envBlock ?? file.deploymentBlock ?? 0 };
}
