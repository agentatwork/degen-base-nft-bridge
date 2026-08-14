// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title BridgedNFT — the destination side of a one-way NFT bridge.
/// @notice One collection holds every bridged token, as the bounty suggests, with each
///         token carrying its own metadata URI copied from the origin chain.
///
/// Two properties matter more than the minting itself:
///
/// 1. **Minting is idempotent per origin token.** The relayer is an off-chain process;
///    it will be restarted mid-run, it will see the same receipt twice after a reorg,
///    and it may be run twice by accident. A naive "mint on every burn seen" duplicates
///    tokens in all three cases. The origin triple is the identity, and the contract —
///    not the relayer's bookkeeping — enforces that it mints at most once.
///
/// 2. **Provenance is on-chain and public.** Every token records the chain, contract and
///    id it came from, so anyone can check a minted token against the burn receipt on
///    the source chain without trusting the relayer's word for it. A one-way bridge
///    with a trusted relayer cannot be made trustless, but it can be made auditable.
contract BridgedNFT is ERC721URIStorage {
    struct Origin {
        uint256 chainId;
        address collection;
        uint256 tokenId;
    }

    address public relayer;
    address public admin;
    uint256 public totalMinted;

    mapping(uint256 => Origin) private _origin;   // local tokenId -> where it came from
    mapping(bytes32 => uint256) private _minted;  // origin key -> local tokenId + 1

    event Bridged(
        uint256 indexed tokenId,
        uint256 indexed originChainId,
        address indexed originCollection,
        uint256 originTokenId,
        address to
    );
    event RelayerChanged(address indexed from, address indexed to);

    error NotRelayer();
    error NotAdmin();
    error AlreadyBridged(uint256 existingTokenId);
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, address relayer_)
        ERC721(name_, symbol_)
    {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
        admin = msg.sender;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    /// The relayer holds a hot key on a server that polls another chain, which is the
    /// most likely thing in this system to be compromised. Rotating it must not require
    /// redeploying the collection or migrating any token.
    function setRelayer(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        if (next == address(0)) revert ZeroAddress();
        emit RelayerChanged(relayer, next);
        relayer = next;
    }

    function originKey(uint256 chainId, address collection, uint256 tokenId)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, collection, tokenId));
    }

    /// @notice Mint the copy of a token burned on the origin chain.
    /// @dev Reverts if this origin token was already bridged. The revert is deliberate
    ///      rather than a silent no-op: a relayer that re-submits is either buggy or
    ///      replaying, and both are worth surfacing. `bridgedTokenOf` lets a well-behaved
    ///      relayer check first and skip without paying for a failed transaction.
    function bridgeMint(
        address to,
        uint256 originChainId,
        address originCollection,
        uint256 originTokenId,
        string calldata uri
    ) external onlyRelayer returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        bytes32 k = originKey(originChainId, originCollection, originTokenId);
        uint256 existing = _minted[k];
        if (existing != 0) revert AlreadyBridged(existing - 1);

        tokenId = totalMinted++;
        _minted[k] = tokenId + 1;          // +1 so that 0 stays "not minted"
        _origin[tokenId] = Origin(originChainId, originCollection, originTokenId);

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);

        emit Bridged(tokenId, originChainId, originCollection, originTokenId, to);
    }

    // ---- provenance --------------------------------------------------------

    function originOf(uint256 tokenId) external view returns (Origin memory) {
        _requireOwned(tokenId);
        return _origin[tokenId];
    }

    /// @return exists whether this origin token has been bridged, and its local id.
    function bridgedTokenOf(uint256 chainId, address collection, uint256 tokenId)
        external
        view
        returns (bool exists, uint256 localTokenId)
    {
        uint256 v = _minted[originKey(chainId, collection, tokenId)];
        return (v != 0, v == 0 ? 0 : v - 1);
    }
}
