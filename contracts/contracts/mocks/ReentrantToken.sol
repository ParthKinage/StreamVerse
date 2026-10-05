// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReceiverHook {
    function onTokenReceived() external;
}

/// @dev TEST ONLY. ERC-20 that calls back into a contract recipient to simulate ERC-777 style reentrancy.
contract ReentrantToken is ERC20 {
    constructor() ERC20("Reentrant", "RE") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length > 0 && from != address(0)) {
            try IReceiverHook(to).onTokenReceived() {} catch {}
        }
    }
}
