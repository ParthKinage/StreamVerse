const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

const E = (n) => ethers.parseEther(String(n));
const DELAY = 15 * 60;
const FEE_BPS = 1000n;
const id = (label) => ethers.id(label);

async function deployFixture() {
  const [admin, relayer, viewer, viewer2, creator, creator2, other, treasury] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory('StreamCoin')).deploy(100_000_000);
  const router = await (await ethers.getContractFactory('PaymentRouter')).deploy(
    await token.getAddress(), admin.address, FEE_BPS, DELAY,
  );
  await router.grantRole(await router.SETTLER_ROLE(), relayer.address);
  for (const s of [viewer, viewer2, other]) {
    await token.transfer(s.address, E(1000));
    await token.connect(s).approve(await router.getAddress(), ethers.MaxUint256);
  }
  return { token, router, admin, relayer, viewer, viewer2, creator, creator2, other, treasury };
}

const settle = (router, relayer, items) =>
  router.connect(relayer).settleBatch(items.map(([i, v, c, a]) => ({ id: id(i), viewer: v.address, creator: c.address, amount: a })));

describe('StreamCoin', () => {
  it('has the expected metadata and mints the initial supply to the deployer', async () => {
    const { token, admin } = await loadFixture(deployFixture);
    expect(await token.name()).to.equal('StreamCoin');
    expect(await token.symbol()).to.equal('STRM');
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(E(100_000_000));
    expect(await token.balanceOf(admin.address)).to.equal(E(100_000_000 - 3000));
  });
});

describe('PaymentRouter', () => {
  describe('constructor', () => {
    it('rejects zero addresses and fees above the cap', async () => {
      const f = await ethers.getContractFactory('PaymentRouter');
      const { token, admin } = await loadFixture(deployFixture);
      const t = await token.getAddress();
      await expect(f.deploy(ethers.ZeroAddress, admin.address, 0, DELAY)).to.be.revertedWithCustomError(f, 'ZeroAddress');
      await expect(f.deploy(t, ethers.ZeroAddress, 0, DELAY)).to.be.revertedWithCustomError(f, 'ZeroAddress');
      await expect(f.deploy(t, admin.address, 3001, DELAY)).to.be.revertedWithCustomError(f, 'FeeTooHigh').withArgs(3001);
    });
  });

  describe('deposits', () => {
    it('deposit credits escrow and pulls tokens', async () => {
      const { token, router, viewer } = await loadFixture(deployFixture);
      await expect(router.connect(viewer).deposit(E(100)))
        .to.emit(router, 'Deposited').withArgs(viewer.address, viewer.address, E(100));
      expect(await router.escrow(viewer.address)).to.equal(E(100));
      expect(await token.balanceOf(await router.getAddress())).to.equal(E(100));
    });

    it('rejects a zero deposit', async () => {
      const { router, viewer } = await loadFixture(deployFixture);
      await expect(router.connect(viewer).deposit(0)).to.be.revertedWithCustomError(router, 'ZeroAmount');
    });

    it('depositFor credits another viewer and rejects the zero address', async () => {
      const { router, viewer, other } = await loadFixture(deployFixture);
      await expect(router.connect(other).depositFor(viewer.address, E(5)))
        .to.emit(router, 'Deposited').withArgs(viewer.address, other.address, E(5));
      expect(await router.escrow(viewer.address)).to.equal(E(5));
      await expect(router.connect(other).depositFor(ethers.ZeroAddress, E(1))).to.be.revertedWithCustomError(router, 'ZeroAddress');
    });

    async function signPermit(token, owner, spender, value, deadline) {
      const { chainId } = await ethers.provider.getNetwork();
      const nonce = await token.nonces(owner.address);
      const domain = { name: 'StreamCoin', version: '1', chainId, verifyingContract: await token.getAddress() };
      const types = { Permit: [
        { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' } ] };
      const sig = ethers.Signature.from(await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce, deadline }));
      return sig;
    }

    it('depositWithPermit tops up in one transaction', async () => {
      const { token, router, viewer } = await loadFixture(deployFixture);
      await token.connect(viewer).approve(await router.getAddress(), 0);
      const deadline = (await time.latest()) + 3600;
      const sig = await signPermit(token, viewer, await router.getAddress(), E(40), deadline);
      await router.connect(viewer).depositWithPermit(E(40), deadline, sig.v, sig.r, sig.s);
      expect(await router.escrow(viewer.address)).to.equal(E(40));
    });

    it('depositWithPermit survives a front-run permit when allowance is sufficient', async () => {
      const { token, router, viewer } = await loadFixture(deployFixture);
      await token.connect(viewer).approve(await router.getAddress(), 0);
      const deadline = (await time.latest()) + 3600;
      const sig = await signPermit(token, viewer, await router.getAddress(), E(10), deadline);
      await token.permit(viewer.address, await router.getAddress(), E(10), deadline, sig.v, sig.r, sig.s); // front-run
      await router.connect(viewer).depositWithPermit(E(10), deadline, sig.v, sig.r, sig.s);
      expect(await router.escrow(viewer.address)).to.equal(E(10));
    });

    it('depositWithPermit reverts when the permit is invalid and there is no allowance', async () => {
      const { token, router, viewer } = await loadFixture(deployFixture);
      await token.connect(viewer).approve(await router.getAddress(), 0);
      const deadline = (await time.latest()) + 3600;
      const sig = await signPermit(token, viewer, await router.getAddress(), E(10), deadline);
      await expect(router.connect(viewer).depositWithPermit(E(11), deadline, sig.v, sig.r, sig.s))
        .to.be.revertedWithCustomError(router, 'InsufficientAllowance');
    });
  });

  describe('withdrawals', () => {
    it('follows request, wait, execute', async () => {
      const { token, router, viewer } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(100));
      const before = await token.balanceOf(viewer.address);
      const tx = await router.connect(viewer).requestWithdraw(E(60));
      const unlockAt = BigInt(await time.latest()) + BigInt(DELAY);
      await expect(tx).to.emit(router, 'WithdrawRequested').withArgs(viewer.address, E(60), unlockAt);
      expect(await router.escrow(viewer.address)).to.equal(E(40));
      expect(await router.pendingWithdrawal(viewer.address)).to.equal(E(60));
      await expect(router.connect(viewer).executeWithdraw())
        .to.be.revertedWithCustomError(router, 'WithdrawalLocked').withArgs(unlockAt);
      await time.increaseTo(unlockAt);
      await expect(router.connect(viewer).executeWithdraw()).to.emit(router, 'Withdrawn').withArgs(viewer.address, E(60));
      expect(await token.balanceOf(viewer.address)).to.equal(before + E(60));
      expect(await router.pendingWithdrawal(viewer.address)).to.equal(0n);
      expect(await router.withdrawUnlockAt(viewer.address)).to.equal(0n);
    });

    it('allows one open request, validates amounts and escrow', async () => {
      const { router, viewer } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(10));
      await expect(router.connect(viewer).requestWithdraw(0)).to.be.revertedWithCustomError(router, 'ZeroAmount');
      await expect(router.connect(viewer).requestWithdraw(E(11)))
        .to.be.revertedWithCustomError(router, 'InsufficientEscrow').withArgs(viewer.address, E(10), E(11));
      await router.connect(viewer).requestWithdraw(E(5));
      await expect(router.connect(viewer).requestWithdraw(E(1))).to.be.revertedWithCustomError(router, 'WithdrawalAlreadyPending');
    });

    it('cancel returns the pending amount to escrow', async () => {
      const { router, viewer } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(10));
      await router.connect(viewer).requestWithdraw(E(10));
      await expect(router.connect(viewer).cancelWithdraw()).to.emit(router, 'WithdrawCancelled').withArgs(viewer.address, E(10));
      expect(await router.escrow(viewer.address)).to.equal(E(10));
      expect(await router.withdrawUnlockAt(viewer.address)).to.equal(0n);
      await expect(router.connect(viewer).cancelWithdraw()).to.be.revertedWithCustomError(router, 'NoPendingWithdrawal');
    });

    it('execute without a request reverts', async () => {
      const { router, viewer } = await loadFixture(deployFixture);
      await expect(router.connect(viewer).executeWithdraw()).to.be.revertedWithCustomError(router, 'NoPendingWithdrawal');
    });

    it('execute pays nothing when settlement consumed the whole pending amount', async () => {
      const { token, router, relayer, viewer, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(10));
      await router.connect(viewer).requestWithdraw(E(10));
      await settle(router, relayer, [['s1', viewer, creator, E(10)]]);
      await time.increase(DELAY);
      const before = await token.balanceOf(viewer.address);
      await expect(router.connect(viewer).executeWithdraw()).to.emit(router, 'Withdrawn').withArgs(viewer.address, 0n);
      expect(await token.balanceOf(viewer.address)).to.equal(before);
    });
  });

  describe('settlement', () => {
    it('debits the viewer and splits the fee between creator and platform', async () => {
      const { router, relayer, viewer, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(100));
      const amount = E(10) + 7n;
      const fee = (amount * FEE_BPS) / 10000n;
      await expect(settle(router, relayer, [['s1', viewer, creator, amount]]))
        .to.emit(router, 'Settled').withArgs(id('s1'), viewer.address, creator.address, amount, fee);
      expect(await router.escrow(viewer.address)).to.equal(E(100) - amount);
      expect(await router.creatorEarnings(creator.address)).to.equal(amount - fee);
      expect(await router.platformEarnings()).to.equal(fee);
      expect(await router.settled(id('s1'))).to.equal(true);
    });

    it('settles several items for several creators in one batch', async () => {
      const { router, relayer, viewer, viewer2, creator, creator2 } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(50));
      await router.connect(viewer2).deposit(E(50));
      await settle(router, relayer, [['a', viewer, creator, E(10)], ['b', viewer2, creator, E(20)], ['c', viewer, creator2, E(5)]]);
      expect(await router.creatorEarnings(creator.address)).to.equal(E(27));
      expect(await router.creatorEarnings(creator2.address)).to.equal(E(4.5));
      expect(await router.platformEarnings()).to.equal(E(3.5));
      expect(await router.escrow(viewer.address)).to.equal(E(35));
    });

    it('rejects a second settlement of the same id, within and across batches', async () => {
      const { router, relayer, viewer, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(50));
      await settle(router, relayer, [['s1', viewer, creator, E(1)]]);
      await expect(settle(router, relayer, [['s1', viewer, creator, E(1)]]))
        .to.be.revertedWithCustomError(router, 'AlreadySettled').withArgs(id('s1'));
      await expect(settle(router, relayer, [['s2', viewer, creator, E(1)], ['s2', viewer, creator, E(1)]]))
        .to.be.revertedWithCustomError(router, 'AlreadySettled').withArgs(id('s2'));
      expect(await router.escrow(viewer.address)).to.equal(E(49)); // failed batches left no trace
    });

    it('draws from the pending withdrawal when escrow is short', async () => {
      const { router, relayer, viewer, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(10));
      await router.connect(viewer).requestWithdraw(E(8)); // escrow 2, pending 8
      await settle(router, relayer, [['s1', viewer, creator, E(5)]]);
      expect(await router.escrow(viewer.address)).to.equal(0n);
      expect(await router.pendingWithdrawal(viewer.address)).to.equal(E(5));
    });

    it('reverts when escrow plus pending cannot cover the amount', async () => {
      const { router, relayer, viewer, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(10));
      await router.connect(viewer).requestWithdraw(E(4));
      await expect(settle(router, relayer, [['s1', viewer, creator, E(11)]]))
        .to.be.revertedWithCustomError(router, 'InsufficientEscrow').withArgs(viewer.address, E(10), E(11));
      expect(await router.settled(id('s1'))).to.equal(false);
    });

    it('validates items, empty batches and the batch size limit', async () => {
      const { router, relayer, viewer, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(10));
      await expect(router.connect(relayer).settleBatch([])).to.be.revertedWithCustomError(router, 'EmptyBatch');
      await expect(settle(router, relayer, [['z', viewer, creator, 0n]])).to.be.revertedWithCustomError(router, 'ZeroAmount');
      await expect(router.connect(relayer).settleBatch([{ id: id('q'), viewer: viewer.address, creator: ethers.ZeroAddress, amount: 1n }]))
        .to.be.revertedWithCustomError(router, 'ZeroAddress');
      await expect(router.connect(relayer).settleBatch([{ id: id('q'), viewer: ethers.ZeroAddress, creator: creator.address, amount: 1n }]))
        .to.be.revertedWithCustomError(router, 'ZeroAddress');
      const max = Number(await router.MAX_BATCH_SIZE());
      const make = (n) => Array.from({ length: n }, (_, i) => ({ id: id(`b${i}`), viewer: viewer.address, creator: creator.address, amount: 1n }));
      await expect(router.connect(relayer).settleBatch(make(max + 1)))
        .to.be.revertedWithCustomError(router, 'BatchTooLarge').withArgs(max + 1);
      await router.connect(relayer).settleBatch(make(max));
      expect(await router.escrow(viewer.address)).to.equal(E(10) - BigInt(max));
    });

    it('only the settler role can settle', async () => {
      const { router, viewer, creator, other } = await loadFixture(deployFixture);
      await expect(settle(router, other, [['s', viewer, creator, 1n]])).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('platform-run wallets (relayer credits and payouts)', () => {
    const credit = (router, signer, items) =>
      router.connect(signer).creditBatch(items.map(([i, v, a]) => ({ id: id(i), viewer: v.address ?? v, amount: a })));

    async function fundedRelayer() {
      const f = await loadFixture(deployFixture);
      await f.token.transfer(f.relayer.address, E(1000));
      await f.token.connect(f.relayer).approve(await f.router.getAddress(), ethers.MaxUint256);
      return f;
    }

    it('credits several viewers in one transaction from the relayer balance', async () => {
      const { token, router, relayer, viewer, viewer2 } = await fundedRelayer();
      const tx = credit(router, relayer, [['c1', viewer, E(50)], ['c2', viewer2, E(20)], ['c3', viewer, E(5)]]);
      await expect(tx).to.emit(router, 'Deposited').withArgs(viewer.address, relayer.address, E(50));
      await expect(tx).to.emit(router, 'Credited').withArgs(id('c2'), viewer2.address, E(20));
      expect(await router.escrow(viewer.address)).to.equal(E(55));
      expect(await router.escrow(viewer2.address)).to.equal(E(20));
      expect(await token.balanceOf(await router.getAddress())).to.equal(E(75));
      expect(await token.balanceOf(relayer.address)).to.equal(E(925));
      expect(await router.credited(id('c1'))).to.equal(true);
    });

    it('never credits the same id twice, within or across batches', async () => {
      const { router, relayer, viewer } = await fundedRelayer();
      await credit(router, relayer, [['c1', viewer, E(10)]]);
      await expect(credit(router, relayer, [['c1', viewer, E(10)]])).to.be.revertedWithCustomError(router, 'AlreadyCredited').withArgs(id('c1'));
      await expect(credit(router, relayer, [['c2', viewer, E(1)], ['c2', viewer, E(1)]])).to.be.revertedWithCustomError(router, 'AlreadyCredited');
      expect(await router.escrow(viewer.address)).to.equal(E(10));
    });

    it('validates items, batch size, the role and the pause switch', async () => {
      const { router, admin, relayer, viewer, other } = await fundedRelayer();
      await expect(credit(router, relayer, [])).to.be.revertedWithCustomError(router, 'EmptyBatch');
      await expect(credit(router, relayer, [['z', viewer, 0n]])).to.be.revertedWithCustomError(router, 'ZeroAmount');
      await expect(credit(router, relayer, [['z', ethers.ZeroAddress, 1n]])).to.be.revertedWithCustomError(router, 'ZeroAddress');
      const tooMany = Array.from({ length: 101 }, (_, i) => [`m${i}`, viewer, 1n]);
      await expect(credit(router, relayer, tooMany)).to.be.revertedWithCustomError(router, 'BatchTooLarge').withArgs(101);
      await expect(credit(router, other, [['z', viewer, 1n]])).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
      await router.connect(admin).pause();
      await expect(credit(router, relayer, [['z', viewer, 1n]])).to.be.revertedWithCustomError(router, 'EnforcedPause');
    });

    it('reverts the whole batch when the relayer cannot pay for it', async () => {
      const { router, relayer, viewer } = await fundedRelayer();
      await expect(credit(router, relayer, [['big', viewer, E(1001)]])).to.be.reverted;
      expect(await router.escrow(viewer.address)).to.equal(0n);
      expect(await router.credited(id('big'))).to.equal(false);
    });

    it('pays a creator out to their own address without the creator sending a transaction', async () => {
      const { token, router, relayer, viewer, creator, other } = await fundedRelayer();
      await credit(router, relayer, [['c1', viewer, E(100)]]);
      await settle(router, relayer, [['s1', viewer, creator, E(10)]]);
      await expect(router.connect(other).claimEarningsFor(creator.address)).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
      const before = await token.balanceOf(relayer.address);
      await expect(router.connect(relayer).claimEarningsFor(creator.address))
        .to.emit(router, 'EarningsClaimed').withArgs(creator.address, E(9));
      expect(await token.balanceOf(creator.address)).to.equal(E(9));
      expect(await token.balanceOf(relayer.address)).to.equal(before);
      expect(await router.creatorEarnings(creator.address)).to.equal(0n);
      await expect(router.connect(relayer).claimEarningsFor(creator.address)).to.be.revertedWithCustomError(router, 'NothingToClaim');
    });

    it('stays solvent with credits, a 30% commission and payouts', async () => {
      const { token, router, admin, relayer, viewer, creator, treasury } = await fundedRelayer();
      await router.connect(admin).setFeeBps(3000);
      await credit(router, relayer, [['c1', viewer, E(100)]]);
      await expect(settle(router, relayer, [['s1', viewer, creator, E(10)]]))
        .to.emit(router, 'Settled').withArgs(id('s1'), viewer.address, creator.address, E(10), E(3));
      expect(await router.creatorEarnings(creator.address)).to.equal(E(7));
      expect(await router.platformEarnings()).to.equal(E(3));
      await router.connect(relayer).claimEarningsFor(creator.address);
      await router.connect(admin).withdrawPlatformFees(treasury.address);
      expect(await token.balanceOf(treasury.address)).to.equal(E(3));
      expect(await token.balanceOf(await router.getAddress())).to.equal(await router.escrow(viewer.address));
      expect(await router.escrow(viewer.address)).to.equal(E(90));
    });
  });

  describe('creator earnings and platform fees', () => {
    it('creator claims; a second claim reverts', async () => {
      const { token, router, relayer, viewer, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(100));
      await settle(router, relayer, [['s1', viewer, creator, E(10)]]);
      await expect(router.connect(creator).claimEarnings()).to.emit(router, 'EarningsClaimed').withArgs(creator.address, E(9));
      expect(await token.balanceOf(creator.address)).to.equal(E(9));
      await expect(router.connect(creator).claimEarnings()).to.be.revertedWithCustomError(router, 'NothingToClaim');
    });

    it('admin withdraws platform fees', async () => {
      const { token, router, admin, relayer, viewer, creator, treasury, other } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(100));
      await settle(router, relayer, [['s1', viewer, creator, E(10)]]);
      await expect(router.connect(other).withdrawPlatformFees(treasury.address)).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
      await expect(router.withdrawPlatformFees(ethers.ZeroAddress)).to.be.revertedWithCustomError(router, 'ZeroAddress');
      await expect(router.connect(admin).withdrawPlatformFees(treasury.address))
        .to.emit(router, 'PlatformFeesWithdrawn').withArgs(treasury.address, E(1));
      expect(await token.balanceOf(treasury.address)).to.equal(E(1));
      await expect(router.withdrawPlatformFees(treasury.address)).to.be.revertedWithCustomError(router, 'NothingToClaim');
    });

    it('is always solvent: contract balance equals escrow + pending + earnings', async () => {
      const { token, router, relayer, viewer, viewer2, creator } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(30));
      await router.connect(viewer2).deposit(E(20));
      await router.connect(viewer2).requestWithdraw(E(5));
      await settle(router, relayer, [['a', viewer, creator, E(7)], ['b', viewer2, creator, E(3)]]);
      const sum = (await router.escrow(viewer.address)) + (await router.escrow(viewer2.address)) +
        (await router.pendingWithdrawal(viewer2.address)) + (await router.creatorEarnings(creator.address)) + (await router.platformEarnings());
      expect(await token.balanceOf(await router.getAddress())).to.equal(sum);
    });
  });

  describe('fee configuration', () => {
    it('admin sets the fee within the cap; others cannot', async () => {
      const { router, relayer, other } = await loadFixture(deployFixture);
      await expect(router.setFeeBps(500)).to.emit(router, 'FeeBpsUpdated').withArgs(FEE_BPS, 500n);
      expect(await router.feeBps()).to.equal(500n);
      await router.setFeeBps(3000);
      await expect(router.setFeeBps(3001)).to.be.revertedWithCustomError(router, 'FeeTooHigh').withArgs(3001);
      await expect(router.connect(other).setFeeBps(1)).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
      await expect(router.connect(relayer).setFeeBps(1)).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('pause', () => {
    it('pauses deposits and settlement but keeps withdrawals and claims open', async () => {
      const { router, relayer, viewer, creator, other } = await loadFixture(deployFixture);
      await router.connect(viewer).deposit(E(20));
      await settle(router, relayer, [['s1', viewer, creator, E(2)]]);
      await expect(router.connect(other).pause()).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
      await router.pause();
      await expect(router.connect(viewer).deposit(E(1))).to.be.revertedWithCustomError(router, 'EnforcedPause');
      await expect(router.connect(viewer).depositFor(other.address, E(1))).to.be.revertedWithCustomError(router, 'EnforcedPause');
      await expect(router.connect(viewer).depositWithPermit(E(1), 0, 27, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(router, 'EnforcedPause');
      await expect(settle(router, relayer, [['s2', viewer, creator, E(1)]])).to.be.revertedWithCustomError(router, 'EnforcedPause');
      await router.connect(viewer).requestWithdraw(E(5));
      await time.increase(DELAY);
      await router.connect(viewer).executeWithdraw();
      await router.connect(creator).claimEarnings();
      await expect(router.connect(other).unpause()).to.be.revertedWithCustomError(router, 'AccessControlUnauthorizedAccount');
      await router.unpause();
      await router.connect(viewer).deposit(E(1));
    });
  });

  describe('reentrancy', () => {
    async function attackFixture() {
      const [admin, relayer, creator] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory('ReentrantToken')).deploy();
      const router = await (await ethers.getContractFactory('PaymentRouter')).deploy(await token.getAddress(), admin.address, FEE_BPS, DELAY);
      await router.grantRole(await router.SETTLER_ROLE(), relayer.address);
      const attacker = await (await ethers.getContractFactory('ReentrancyAttacker')).deploy(await router.getAddress(), await token.getAddress());
      await token.transfer(await attacker.getAddress(), E(100));
      return { token, router, attacker, relayer, creator };
    }

    it('blocks re-entering executeWithdraw from the token callback', async () => {
      const { router, attacker } = await loadFixture(attackFixture);
      await attacker.fundAndDeposit(E(100));
      await attacker.requestWithdraw(E(100));
      await time.increase(DELAY);
      await attacker.arm(router.interface.getFunction('executeWithdraw').selector);
      await attacker.executeWithdraw();
      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await router.pendingWithdrawal(await attacker.getAddress())).to.equal(0n);
    });

    it('blocks re-entering claimEarnings from the token callback', async () => {
      const { router, attacker, relayer, creator } = await loadFixture(attackFixture);
      await attacker.fundAndDeposit(E(100));
      await router.connect(relayer).settleBatch([{ id: id('x'), viewer: await attacker.getAddress(), creator: await attacker.getAddress(), amount: E(50) }]);
      await attacker.arm(router.interface.getFunction('claimEarnings').selector);
      await attacker.claim();
      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(creator).to.not.equal(undefined);
    });
  });
});
