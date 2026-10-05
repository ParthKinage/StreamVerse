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
    },
  },
  paths: { sources: './contracts', tests: './test', cache: './cache', artifacts: './artifacts' },
  mocha: { timeout: 120000 },
};
