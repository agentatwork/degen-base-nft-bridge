// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBurnVault {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

/// @notice A collection that calls the vault's receive hook directly, without ever
///         transferring a token. The vault trusts msg.sender as the collection address,
///         so this is the shape of the only spoof available: a contract can register
///         receipts for tokens of its own collection. It cannot forge a receipt for
///         somebody else's collection, and the duplicate guard stops it registering the
///         same token twice. Used only by the tests.
contract Rogue {
    function poke(address vault, address holder, uint256 tokenId) external {
        IBurnVault(vault).onERC721Received(address(this), holder, tokenId, "");
    }
}
