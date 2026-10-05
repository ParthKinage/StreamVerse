// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title PaymentRouter
 * @notice Prepaid escrow with batched settlement for StreamVerse.
 *
 * Viewers deposit STRM. Watch time is metered off-chain; a relayer (SETTLER_ROLE) settles finished sessions in
 * batches, debiting the viewer and crediting the creator and the platform. Viewers withdraw unspent escrow in two
 * steps (request, then execute after `withdrawDelay`) so charges that are still pending off-chain can settle first.
 * Settlement draws from escrow first and then from the viewer's pending withdrawal.
 */
contract PaymentRouter is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct Settlement {
        bytes32 id;
        address viewer;
        address creator;
        uint256 amount;
    }

    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    uint256 public constant MAX_FEE_BPS = 3000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_BATCH_SIZE = 100;

    IERC20 public immutable token;
    uint256 public immutable withdrawDelay;
    uint256 public feeBps;

    mapping(address viewer => uint256) public escrow;
    mapping(address viewer => uint256) public pendingWithdrawal;
    mapping(address viewer => uint256) public withdrawUnlockAt;
    mapping(address creator => uint256) public creatorEarnings;
    uint256 public platformEarnings;
    mapping(bytes32 id => bool) public settled;

    event Deposited(address indexed viewer, address indexed payer, uint256 amount);
    event WithdrawRequested(address indexed viewer, uint256 amount, uint256 unlockAt);
    event WithdrawCancelled(address indexed viewer, uint256 amount);
    event Withdrawn(address indexed viewer, uint256 amount);
    event Settled(
        bytes32 indexed id,
        address indexed viewer,
        address indexed creator,
        uint256 amount,
        uint256 fee
    );
    event EarningsClaimed(address indexed creator, uint256 amount);
    event PlatformFeesWithdrawn(address indexed to, uint256 amount);
    event FeeBpsUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientEscrow(address viewer, uint256 available, uint256 requested);
    error WithdrawalAlreadyPending();
    error NoPendingWithdrawal();
    error WithdrawalLocked(uint256 unlockAt);
    error AlreadySettled(bytes32 id);
    error BatchTooLarge(uint256 size);
    error EmptyBatch();
    error NothingToClaim();
    error FeeTooHigh(uint256 feeBps);
    error InsufficientAllowance();

    constructor(IERC20 token_, address admin, uint256 feeBps_, uint256 withdrawDelay_) {
        if (address(token_) == address(0) || admin == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        token = token_;
        withdrawDelay = withdrawDelay_;
        feeBps = feeBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- viewer

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        _deposit(msg.sender, msg.sender, amount);
    }

    function depositFor(address viewer, uint256 amount) external nonReentrant whenNotPaused {
        if (viewer == address(0)) revert ZeroAddress();
        _deposit(viewer, msg.sender, amount);
    }

    /// @notice One-transaction top-up: EIP-2612 permit followed by deposit.
    /// @dev A failed permit (for example a front-run) is tolerated as long as the allowance already suffices.
    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        whenNotPaused
    {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {
            if (token.allowance(msg.sender, address(this)) < amount) revert InsufficientAllowance();
        }
        _deposit(msg.sender, msg.sender, amount);
    }

    function requestWithdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (pendingWithdrawal[msg.sender] != 0) revert WithdrawalAlreadyPending();
        uint256 available = escrow[msg.sender];
        if (available < amount) revert InsufficientEscrow(msg.sender, available, amount);
        escrow[msg.sender] = available - amount;
        pendingWithdrawal[msg.sender] = amount;
        uint256 unlockAt = block.timestamp + withdrawDelay;
        withdrawUnlockAt[msg.sender] = unlockAt;
        emit WithdrawRequested(msg.sender, amount, unlockAt);
    }

    function cancelWithdraw() external {
        uint256 amount = pendingWithdrawal[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();
        pendingWithdrawal[msg.sender] = 0;
        withdrawUnlockAt[msg.sender] = 0;
        escrow[msg.sender] += amount;
        emit WithdrawCancelled(msg.sender, amount);
    }

    /// @notice Pays out whatever remains of the pending withdrawal once the delay has passed.
    function executeWithdraw() external nonReentrant {
        uint256 amount = pendingWithdrawal[msg.sender];
        if (withdrawUnlockAt[msg.sender] == 0) revert NoPendingWithdrawal();
        uint256 unlockAt = withdrawUnlockAt[msg.sender];
        if (block.timestamp < unlockAt) revert WithdrawalLocked(unlockAt);
        pendingWithdrawal[msg.sender] = 0;
        withdrawUnlockAt[msg.sender] = 0;
        if (amount != 0) {
            token.safeTransfer(msg.sender, amount);
        }
        emit Withdrawn(msg.sender, amount);
    }

    // --------------------------------------------------------------- settler

    function settleBatch(Settlement[] calldata items) external nonReentrant whenNotPaused onlyRole(SETTLER_ROLE) {
        uint256 n = items.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH_SIZE) revert BatchTooLarge(n);
        uint256 bps = feeBps;
        for (uint256 i = 0; i < n; i++) {
            Settlement calldata it = items[i];
            if (settled[it.id]) revert AlreadySettled(it.id);
            if (it.amount == 0) revert ZeroAmount();
            if (it.creator == address(0) || it.viewer == address(0)) revert ZeroAddress();
            settled[it.id] = true;

            uint256 fromEscrow = escrow[it.viewer];
            if (fromEscrow >= it.amount) {
                escrow[it.viewer] = fromEscrow - it.amount;
            } else {
                uint256 shortfall = it.amount - fromEscrow;
                uint256 pending = pendingWithdrawal[it.viewer];
                if (pending < shortfall) {
                    revert InsufficientEscrow(it.viewer, fromEscrow + pending, it.amount);
                }
                escrow[it.viewer] = 0;
                pendingWithdrawal[it.viewer] = pending - shortfall;
            }

            uint256 fee = (it.amount * bps) / BPS_DENOMINATOR;
            creatorEarnings[it.creator] += it.amount - fee;
            platformEarnings += fee;
            emit Settled(it.id, it.viewer, it.creator, it.amount, fee);
        }
    }

    // --------------------------------------------------------------- creator

    function claimEarnings() external nonReentrant {
        uint256 amount = creatorEarnings[msg.sender];
        if (amount == 0) revert NothingToClaim();
        creatorEarnings[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit EarningsClaimed(msg.sender, amount);
    }

    // ----------------------------------------------------------------- admin

    function withdrawPlatformFees(address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = platformEarnings;
        if (amount == 0) revert NothingToClaim();
        platformEarnings = 0;
        token.safeTransfer(to, amount);
        emit PlatformFeesWithdrawn(to, amount);
    }

    function setFeeBps(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps);
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Pauses deposits and settlement. Withdrawals and claims stay open.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------- internal

    function _deposit(address viewer, address payer, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        escrow[viewer] += amount;
        token.safeTransferFrom(payer, address(this), amount);
        emit Deposited(viewer, payer, amount);
    }
}
