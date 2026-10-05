// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentRouter} from "../PaymentRouter.sol";

/// @dev TEST ONLY. Tries to re-enter PaymentRouter while it is paying out.
contract ReentrancyAttacker {
    PaymentRouter public immutable router;
    IERC20 public immutable token;
    bool public reentered;
    bool public reentrySucceeded;
    bytes4 public mode; // selector to call back with
    bool public armed;

    constructor(PaymentRouter router_, IERC20 token_) {
        router = router_;
        token = token_;
    }

    function arm(bytes4 mode_) external {
        mode = mode_;
        armed = true;
        reentered = false;
        reentrySucceeded = false;
    }

    function fundAndDeposit(uint256 amount) external {
        token.approve(address(router), amount);
        router.deposit(amount);
    }

    function requestWithdraw(uint256 amount) external {
        router.requestWithdraw(amount);
    }

    function executeWithdraw() external {
        router.executeWithdraw();
    }

    function claim() external {
        router.claimEarnings();
    }

    function onTokenReceived() external {
        if (!armed || reentered) return;
        reentered = true;
        (bool ok,) = address(router).call(abi.encodeWithSelector(mode));
        reentrySucceeded = ok;
    }
}
