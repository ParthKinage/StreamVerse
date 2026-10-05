// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title StreamCoin (STRM)
 * @notice ERC-20 token for the StreamVerse pay-as-you-watch platform. Built on OpenZeppelin ERC20 + ERC20Permit
 *         so viewers can top up escrow in a single transaction.
 */
contract StreamCoin is ERC20, ERC20Permit {
    /// @param initialSupply Whole tokens (not wei) minted to the deployer, scaled by 10**decimals().
    constructor(uint256 initialSupply) ERC20("StreamCoin", "STRM") ERC20Permit("StreamCoin") {
        _mint(msg.sender, initialSupply * 10 ** decimals());
    }
}
