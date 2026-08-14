// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Stands in for Arbitrum's ArbSys precompile at 0x64, which every Orbit chain
///         (Degen included) has and no other chain does. The offset makes the two clocks
///         visibly different, which is the entire point: on the real Degen chain,
///         `block.number` and `eth_blockNumber` are about 23 million apart.
///         Used only by the tests, installed with evm_setAccountCode.
contract ArbSysStub {
    function arbBlockNumber() external view returns (uint256) {
        return block.number + 1_000_000;
    }
}
