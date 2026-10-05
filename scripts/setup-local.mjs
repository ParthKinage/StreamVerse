/* One-command local setup (Windows-friendly: no shell-specific syntax).
 * Prerequisites: `npm install`, Postgres + Redis running (npm run dev:infra). A local chain (npm run dev:chain) is only needed when .env has PAYMENTS_MODE=chain.
 * Steps: build shared packages, deploy the contracts to the local chain, write the addresses into .env,
 * apply database migrations, seed demo data. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;

function run(args) {
  console.log(`\n> npm ${args.join(' ')}`);
  const cmd = npm ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const full = npm ? [npm, ...args] : args;
  const res = spawnSync(cmd, full, { cwd: root, stdio: 'inherit', shell: !npm && process.platform === 'win32' });
  if (res.status !== 0) {
    console.error(`\nStep failed: npm ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

const envPath = path.join(root, '.env');
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, '.env.example'), envPath);
  console.log('Created .env from .env.example');
}

const modeMatch = /^PAYMENTS_MODE=(\w+)/m.exec(fs.readFileSync(envPath, 'utf8'));
const chainMode = modeMatch?.[1] === 'chain';

run(['run', 'build:packages']);
if (!chainMode) {
  // Bank mode (the default prototype): no blockchain is needed.
  run(['run', 'prisma:deploy', '-w', '@tesor_gp/database']);
  run(['run', 'seed', '-w', '@tesor_gp/database']);
  console.log('\nLocal setup complete (bank mode, no chain needed). Start everything with: npm run dev');
  process.exit(0);
}
run(['run', 'deploy:local', '-w', '@tesor_gp/contracts']);

const deploymentFile = path.join(root, 'contracts', 'deployments', '31337.json');
if (!fs.existsSync(deploymentFile)) {
  console.error('Deployment file not found. Is the local chain running (npm run dev:chain)?');
  process.exit(1);
}
const dep = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));

function setEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
}
let env = fs.readFileSync(envPath, 'utf8');
env = setEnv(env, 'CHAIN_ID', '31337');
env = setEnv(env, 'STREAMCOIN_TOKEN_ADDRESS', dep.streamCoin);
env = setEnv(env, 'PAYMENT_ROUTER_ADDRESS', dep.paymentRouter);
fs.writeFileSync(envPath, env);
console.log(`Wrote contract addresses to .env (StreamCoin ${dep.streamCoin}, PaymentRouter ${dep.paymentRouter}).`);

run(['run', 'prisma:deploy', '-w', '@tesor_gp/database']);
run(['run', 'seed', '-w', '@tesor_gp/database']);
console.log('\nLocal setup complete. Start everything with: npm run dev');
