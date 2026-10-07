const fs = require('fs');
const path = require('path');
require('@nomicfoundation/hardhat-toolbox');

// Load the repo-level .env (searching upward from the working directory).
(function loadDotenv() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return void require('dotenv').config({ path: candidate });
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
})();

const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

const SOLC_VERSION = '0.8.28';

// Compile with the pure-JS `solc` npm package pinned in package.json. This avoids downloading compiler binaries
// (works offline, behind proxies and identically on Windows, macOS and Linux).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const solc = require('solc');
    return {
      compilerPath: require.resolve('solc/soljson.js'),
      isSolcJs: true,
      version: SOLC_VERSION,
      longVersion: solc.version(),
    };
  }
  return runSuper();
});

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

const { task } = require('hardhat/config');

/** Finds the deployed PaymentRouter for the selected network (deployments/<chainId>.json, or PAYMENT_ROUTER_ADDRESS). */
async function loadRouter(hre) {
  const { chainId } = await hre.ethers.provider.getNetwork();
  const file = path.join(__dirname, 'deployments', `${chainId}.json`);
  const address = process.env.PAYMENT_ROUTER_ADDRESS || (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).paymentRouter : undefined);
  if (!address) throw new Error(`No PaymentRouter address for chain ${chainId}. Deploy first or set PAYMENT_ROUTER_ADDRESS.`);
  return hre.ethers.getContractAt('PaymentRouter', address);
}

task('platform:status', 'Shows the commission rate and the commission the platform has earned so far').setAction(async (_args, hre) => {
  const router = await loadRouter(hre);
  const bps = await router.feeBps();
  console.log(`Router            ${await router.getAddress()}`);
  console.log(`Commission        ${Number(bps) / 100}%`);
  console.log(`Earned, unclaimed ${hre.ethers.formatEther(await router.platformEarnings())} STRM`);
});

task('platform:set-fee', 'Changes the platform commission (admin only)')
  .addParam('bps', 'Commission in basis points, for example 3000 for 30% (maximum 3000)')
  .setAction(async (args, hre) => {
    const router = await loadRouter(hre);
    await (await router.setFeeBps(Number(args.bps))).wait();
    console.log(`Commission is now ${Number(await router.feeBps()) / 100}%`);
  });

task('platform:withdraw-fees', 'Sends the commission earned so far to a treasury address (admin only)')
  .addParam('to', 'Address that receives the STRM')
  .setAction(async (args, hre) => {
    const router = await loadRouter(hre);
    const amount = await router.platformEarnings();
    if (amount === 0n) return void console.log('Nothing to withdraw yet.');
    const receipt = await (await router.withdrawPlatformFees(args.to)).wait();
    console.log(`Sent ${hre.ethers.formatEther(amount)} STRM to ${args.to} (tx ${receipt.hash})`);
  });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 },
    polygonAmoy: {
      url: process.env.POLYGON_AMOY_RPC_URL || 'https://rpc-amoy.polygon.technology',
      chainId: 80002,
      accounts: deployerKey ? [deployerKey] : [],
      // Optional: AMOY_GAS_PRICE_GWEI=30 pins the gas price (Amoy needs >= ~25 gwei) to keep deploy costs predictable.
      ...(process.env.AMOY_GAS_PRICE_GWEI ? { gasPrice: Math.round(Number(process.env.AMOY_GAS_PRICE_GWEI) * 1e9) } : {}),
    },
  },
  paths: { sources: './contracts', tests: './test', cache: './cache', artifacts: './artifacts' },
  mocha: { timeout: 120000 },
};
