// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice A minimal collection used by the tests and the demo to stand in for a real
///         Degen-chain NFT. Not part of the bridge; nothing in the bridge depends on it.
contract DemoNFT is ERC721 {
    uint256 public next;
    mapping(uint256 => string) private _uri;
    bool public breakURI; // to exercise the vault's try/catch path

    constructor() ERC721("Demo Degen NFT", "DEMO") {}

    function mint(address to, string calldata uri) external returns (uint256 id) {
        id = next++;
        _uri[id] = uri;
        _safeMint(to, id);
    }

    function setBreakURI(bool v) external {
        breakURI = v;
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        require(!breakURI, "unrevealed");
        _requireOwned(id);
        return _uri[id];
    }
}
