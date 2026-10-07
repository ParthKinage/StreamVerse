/* Deploys StreamCoin + PaymentRouter, grants SETTLER_ROLE to the relayer, funds the reward pool and writes
 * deployments/<chainId>.json. Run via `npm run deploy:local` or `npm run deploy:amoy` in this workspace. */
const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');

const ZERO_KEY = '0x' + '0'.repeat(64);

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('No deployer account. Set DEPLOYER_PRIVATE_KEY for this network.');
  const { chainId } = await ethers.provider.getNetwork();

  const initialSupply = BigInt(process.env.STRM_INITIAL_SUPPLY || '100000000');
  // Platform commission on every payment, in basis points (3000 = 30%). The contract caps it at 30%.
  const feeBps = Number(process.env.FEE_BPS || 3000);
  const withdrawDelaySec = Number(process.env.WITHDRAW_DELAY_SEC || 15 * 60);
  const rewardPool = ethers.parseEther(process.env.REWARD_POOL_STRM || '1000000');

  // MetaMask exports keys without "0x"; accept both spellings.
  const rawRelayerKey = process.env.SETTLEMENT_RELAYER_PRIVATE_KEY?.trim();
  const relayerKey = rawRelayerKey && /^[0-9a-fA-F]{64}$/.test(rawRelayerKey) ? `0x${rawRelayerKey}` : rawRelayerKey;
  let relayerAddress;
  if (relayerKey && relayerKey.toLowerCase() !== ZERO_KEY) {
    relayerAddress = new ethers.Wallet(relayerKey).address;
  } else if (chainId === 31337n) {
    relayerAddress = deployer.address; // the API defaults to Hardhat account #0 on the local chain
  } else {
    throw new Error('Set SETTLEMENT_RELAYER_PRIVATE_KEY to a real key before deploying to a public network.');
  }

  // REUSE_STREAMCOIN_ADDRESS lets you resume after a deploy that stopped half-way (the token is already on-chain).
  const reuse = process.env.REUSE_STREAMCOIN_ADDRESS;
  const factory = await ethers.getContractFactory('StreamCoin');
  let token;
  if (reuse) {
    if ((await ethers.provider.getCode(reuse)) === '0x') throw new Error('REUSE_STREAMCOIN_ADDRESS has no contract code on this network.');
    token = factory.attach(reuse);
    console.log('Reusing existing StreamCoin at', reuse);
  } else {
    token = await factory.deploy(initialSupply);
    await token.waitForDeployment();
  }
  const router = await (await ethers.getContractFactory('PaymentRouter')).deploy(
    await token.getAddress(), deployer.address, feeBps, withdrawDelaySec,
  );
  const receipt = await router.deploymentTransaction().wait();
  await router.waitForDeployment();

  await (await router.grantRole(await router.SETTLER_ROLE(), relayerAddress)).wait();
  if (relayerAddress.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await token.transfer(relayerAddress, rewardPool)).wait();
  }

  const out = {
    chainId: Number(chainId),
    streamCoin: await token.getAddress(),
    paymentRouter: await router.getAddress(),
    deploymentBlock: receipt.blockNumber,
    deployer: deployer.address,
    relayer: relayerAddress,
    feeBps,
    withdrawDelaySec,
    initialSupply: initialSupply.toString(),
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${chainId}.json`), JSON.stringify(out, null, 2) + '\n');

  console.log(`\nDeployed on chain ${chainId}. Add these to .env:\n`);
  console.log(`CHAIN_ID=${chainId}`);
  console.log(`STREAMCOIN_TOKEN_ADDRESS=${out.streamCoin}`);
  console.log(`PAYMENT_ROUTER_ADDRESS=${out.paymentRouter}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
