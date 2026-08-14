// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";

/// @title BurnVault — the source side of a one-way NFT bridge.
/// @notice Accepts an NFT and keeps it forever. There is no withdrawal function and
///         no owner, by design: the bridge is one-way, so any path back out of this
///         contract would let the same NFT exist on both chains at once.
///
/// The receipts are stored in a plain array with a length getter so an indexer can
/// read them with two eth_calls and no event log queries — some RPC providers cap or
/// charge for eth_getLogs ranges, and an array is the same data with a cheaper and
/// more portable read path. Events are emitted as well, for anyone who prefers them.
contract BurnVault is IERC721Receiver {
    struct Receipt {
        address collection;   // the ERC-721 that was burned
        uint256 tokenId;      // its id on this chain
        address holder;       // who sent it, and therefore who should receive the copy
        string  tokenURI;     // metadata, captured at burn time (see note below)
        uint64  burnedAt;     // block timestamp
        uint64  burnedAtBlock;// this chain's own block number — see chainBlock()
        uint64  burnedAtRefBlock; // whatever block.number reports; on an L3, the parent's
    }

    /// Arbitrum's ArbSys precompile, present on Arbitrum One, Nova, and every Orbit chain
    /// including Degen. Absent everywhere else.
    address private constant ARBSYS = 0x0000000000000000000000000000000000000064;

    /// @notice This chain's own block height, as `eth_blockNumber` reports it.
    /// @dev Not the same thing as `block.number`. On Arbitrum and Orbit chains — Degen is
    ///      one — `block.number` inside a contract returns the *parent* chain's block
    ///      number, which on Degen runs about 23 million blocks ahead of Degen's own. An
    ///      indexer that stores `block.number` and compares it against `eth_blockNumber`
    ///      gets a negative confirmation depth and waits forever. Publishing this as a
    ///      view function means the relayer never has to know which kind of chain it is
    ///      talking to: it reads the same clock the receipts were stamped with.
    function chainBlock() public view returns (uint256) {
        (bool present, bytes memory data) =
            ARBSYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
        if (present && data.length == 32) return abi.decode(data, (uint256));
        return block.number;
    }

    Receipt[] private _receipts;

    /// Guards against the same (collection, tokenId) being recorded twice. It cannot
    /// happen while the vault never releases anything, but it costs one SLOAD and it
    /// means the invariant is enforced rather than merely intended.
    mapping(bytes32 => bool) public burned;

    event Burned(
        uint256 indexed index,
        address indexed collection,
        uint256 indexed tokenId,
        address holder,
        string  tokenURI
    );

    error AlreadyBurned();
    error NotOwner();

    function key(address collection, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(collection, tokenId));
    }

    /// @notice Bridge an NFT you have already approved to this contract.
    function burn(address collection, uint256 tokenId) external {
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotOwner();
        IERC721(collection).transferFrom(msg.sender, address(this), tokenId);
        _record(collection, tokenId, msg.sender);
    }

    /// @notice Bridge by sending the NFT directly with safeTransferFrom — one
    ///         transaction instead of approve-then-call.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        // msg.sender is the collection: only a real ERC-721 can trigger this hook, so
        // the collection address cannot be spoofed by the caller.
        _record(msg.sender, tokenId, from);
        return IERC721Receiver.onERC721Received.selector;
    }

    function _record(address collection, uint256 tokenId, address holder) private {
        bytes32 k = key(collection, tokenId);
        if (burned[k]) revert AlreadyBurned();
        burned[k] = true;

        // Metadata is captured here, at burn time, rather than left for the relayer to
        // fetch later. tokenURI is mutable on many collections, so reading it minutes
        // afterwards can mint a copy of something the original no longer says. Reading
        // it in the same transaction that takes custody pins the two together.
        //
        // try/catch because tokenURI is optional in ERC-721: a collection that omits it,
        // or reverts on an unrevealed token, must still be bridgeable rather than
        // permanently stuck.
        string memory uri;
        try IERC721Metadata(collection).tokenURI(tokenId) returns (string memory u) {
            uri = u;
        } catch {
            uri = "";
        }

        _receipts.push(Receipt({
            collection: collection,
            tokenId: tokenId,
            holder: holder,
            tokenURI: uri,
            burnedAt: uint64(block.timestamp),
            burnedAtBlock: uint64(chainBlock()),
            burnedAtRefBlock: uint64(block.number)
        }));

        emit Burned(_receipts.length - 1, collection, tokenId, holder, uri);
    }

    // ---- read path ---------------------------------------------------------

    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    function receiptAt(uint256 index) external view returns (Receipt memory) {
        return _receipts[index];
    }

    /// @notice Read a window of receipts in one call.
    /// @dev Bounded rather than reverting on an overlong range, so a caller that asks
    ///      for more than exists gets what exists. Paging over a growing array is the
    ///      normal case for an indexer and making it revert would be hostile.
    function receipts(uint256 offset, uint256 limit)
        external
        view
        returns (Receipt[] memory page)
    {
        uint256 n = _receipts.length;
        if (offset >= n) return new Receipt[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        page = new Receipt[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = _receipts[i];
    }
}
