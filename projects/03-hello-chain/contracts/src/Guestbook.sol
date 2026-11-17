// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IGuestbook} from "./IGuestbook.sol";

/// @title Guestbook
/// @notice Append-only on-chain guestbook: 1-140 byte messages, one entry per visitor per cooldown.
/// @dev All write paths funnel through `_record`, the single place that enforces the length and
///      cooldown rules, updates counters, stores the entry and emits `Signed`.
contract Guestbook is IGuestbook, Ownable2Step, EIP712 {
    /// @notice Maximum message length in bytes.
    uint256 public constant MAX_MESSAGE_BYTES = 140;
    /// @notice Maximum page size for paginated reads.
    uint256 public constant MAX_PAGE = 50;
    /// @dev EIP-712 type hash of the signed entry; `message` is hashed as keccak256(bytes(message)).
    bytes32 private constant ENTRY_TYPEHASH =
        keccak256("Entry(bytes32 visitorId,string message,uint256 nonce,uint256 deadline)");
    uint40 private constant MIN_COOLDOWN = 1 hours;
    uint40 private constant MAX_COOLDOWN = 1 days;

    /// @notice Minimum seconds between two entries from the same visitor (fixed at deploy).
    uint40 public immutable COOLDOWN;

    /// @dev Stored entry; visitorId occupies slot 0, timestamp, kind and hidden pack into slot 1.
    struct Entry {
        bytes32 visitorId;
        uint40 timestamp;
        Kind kind;
        bool hidden;
        string message;
    }

    Entry[] private _entries;
    uint256 private _uniqueVisitors;
    mapping(bytes32 visitorId => uint40) private _lastSignedAt;
    mapping(bytes32 visitorId => uint256) private _nonces;

    /// @param initialOwner Initial owner (may hide entries).
    /// @param cooldown Cooldown in seconds; must be within [1 hour, 1 day].
    constructor(address initialOwner, uint40 cooldown) Ownable(initialOwner) EIP712("HelloChain", "1") {
        if (cooldown < MIN_COOLDOWN || cooldown > MAX_COOLDOWN) revert CooldownOutOfRange(cooldown);
        COOLDOWN = cooldown;
    }

    /// @notice Sign the guestbook directly; the caller pays gas and is the visitor.
    /// @param message The message, 1-140 bytes.
    /// @return id The id of the new entry.
    function sign(string calldata message) external returns (uint256 id) {
        id = _record(_visitorId(msg.sender), Kind.Direct, message);
    }

    /// @notice Record an entry on behalf of `author`, who authorised it off-chain with an EIP-712
    ///         signature (EOA via ECDSA or smart wallet via ERC-1271). The caller (relayer) pays gas
    ///         and is never recorded as the author.
    /// @param author The signing wallet; its address determines the visitor id.
    /// @param message The message, 1-140 bytes.
    /// @param deadline Last timestamp (inclusive) at which the signature is valid.
    /// @param signature The signature over `hashEntry(visitorId(author), message, nonce, deadline)`.
    /// @return id The id of the new entry.
    function signWithWallet(address author, string calldata message, uint256 deadline, bytes calldata signature)
        external
        returns (uint256 id)
    {
        // deadline expiry is the intended use of block.timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 visitorId = _visitorId(author);
        uint256 nonce = _nonces[visitorId];
        bytes32 digest = hashEntry(visitorId, message, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(author, digest, signature)) revert InvalidSignature();
        _nonces[visitorId] = nonce + 1;
        id = _record(visitorId, Kind.Wallet, message);
    }

    /// @notice Record an entry authorised by a passkey (WebAuthn assertion over a P-256 key). The
    ///         assertion's challenge must be `hashEntry(passkeyVisitorId(qx, qy), message, nonce, deadline)`
    ///         and the authenticator must report user verification (UV). The caller (relayer) pays gas.
    /// @param qx Passkey public key x coordinate.
    /// @param qy Passkey public key y coordinate.
    /// @param message The message, 1-140 bytes.
    /// @param deadline Last timestamp (inclusive) at which the assertion is valid.
    /// @param auth The WebAuthn assertion (signature, authenticatorData, clientDataJSON and indices).
    /// @return id The id of the new entry.
    function signWithPasskey(
        bytes32 qx,
        bytes32 qy,
        string calldata message,
        uint256 deadline,
        WebAuthn.WebAuthnAuth calldata auth
    ) external returns (uint256 id) {
        // deadline expiry is the intended use of block.timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 visitorId = passkeyVisitorId(qx, qy);
        uint256 nonce = _nonces[visitorId];
        bytes memory challenge = abi.encodePacked(hashEntry(visitorId, message, nonce, deadline));
        // requireUV = true: the visitor must have passed Face ID / fingerprint / PIN, not just touched
        if (!WebAuthn.verify(challenge, auth, qx, qy, true)) revert InvalidSignature();
        _nonces[visitorId] = nonce + 1;
        id = _record(visitorId, Kind.Passkey, message);
    }

    /// @notice Visitor id of a passkey: keccak256(abi.encode(qx, qy)).
    /// @param qx Passkey public key x coordinate.
    /// @param qy Passkey public key y coordinate.
    function passkeyVisitorId(bytes32 qx, bytes32 qy) public pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy));
    }

    /// @notice Next valid nonce for a visitor's signed entries.
    /// @param visitorId The visitor identifier.
    function nonces(bytes32 visitorId) external view returns (uint256) {
        return _nonces[visitorId];
    }

    /// @notice EIP-712 digest a visitor signs to authorise an entry.
    /// @param visitorId The visitor identifier.
    /// @param message The message text.
    /// @param nonce The visitor's current nonce.
    /// @param deadline Signature expiry timestamp.
    /// @return digest The typed-data digest for this contract's domain.
    function hashEntry(bytes32 visitorId, string calldata message, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32 digest)
    {
        digest = _hashTypedDataV4(
            keccak256(abi.encode(ENTRY_TYPEHASH, visitorId, keccak256(bytes(message)), nonce, deadline))
        );
    }

    /// @notice Hide or unhide an entry. The entry itself is never modified or deleted.
    /// @param id The entry id.
    /// @param hidden True to hide, false to unhide.
    function setHidden(uint256 id, bool hidden) external onlyOwner {
        if (id >= _entries.length) revert EntryNotFound(id);
        _entries[id].hidden = hidden;
        emit HiddenSet(id, hidden);
    }

    /// @notice Disabled: the guestbook must always have an owner who can hide abuse.
    /// @dev Ownership can still move via the two-step transferOwnership / acceptOwnership flow.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Whether an entry is hidden by the owner.
    /// @param id The entry id.
    function isHidden(uint256 id) external view returns (bool) {
        if (id >= _entries.length) revert EntryNotFound(id);
        return _entries[id].hidden;
    }

    /// @notice Total number of entries ever recorded.
    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    /// @notice Number of distinct visitors that have signed at least once.
    function uniqueVisitors() external view returns (uint256) {
        return _uniqueVisitors;
    }

    /// @notice Timestamp of a visitor's latest entry, or 0 if they never signed.
    /// @param visitorId The visitor identifier.
    function lastSignedAt(bytes32 visitorId) external view returns (uint40) {
        return _lastSignedAt[visitorId];
    }

    /// @notice Fetch one entry.
    /// @param id The entry id.
    function getEntry(uint256 id) external view returns (EntryView memory) {
        if (id >= _entries.length) revert EntryNotFound(id);
        return _view(id);
    }

    /// @notice Fetch entries in ascending id order, clamped to the end of the log.
    /// @param start First id to return.
    /// @param limit Maximum number of entries (at most `MAX_PAGE`).
    function getEntries(uint256 start, uint256 limit) external view returns (EntryView[] memory page) {
        if (limit > MAX_PAGE) revert PageTooLarge(limit);
        uint256 total = _entries.length;
        if (start >= total) return new EntryView[](0);
        uint256 n = total - start;
        if (n > limit) n = limit;
        page = new EntryView[](n);
        for (uint256 i; i < n; ++i) {
            page[i] = _view(start + i);
        }
    }

    /// @notice Fetch the newest entries, newest first.
    /// @param limit Maximum number of entries (at most `MAX_PAGE`).
    function latest(uint256 limit) external view returns (EntryView[] memory page) {
        if (limit > MAX_PAGE) revert PageTooLarge(limit);
        uint256 total = _entries.length;
        uint256 n = limit < total ? limit : total;
        page = new EntryView[](n);
        for (uint256 i; i < n; ++i) {
            page[i] = _view(total - 1 - i);
        }
    }

    /// @dev Single choke point for all write paths: validates length and cooldown, updates
    ///      counters, stores and emits. Callers are responsible for authenticating `visitorId`.
    function _record(bytes32 visitorId, Kind kind, string calldata message) internal returns (uint256 id) {
        uint256 len = bytes(message).length;
        if (len == 0) revert MessageEmpty();
        if (len > MAX_MESSAGE_BYTES) revert MessageTooLong(len);

        uint40 last = _lastSignedAt[visitorId];
        // casting to 'uint40' is safe because block.timestamp < 2^40 (~year 36812)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint40 nowTs = uint40(block.timestamp);
        // lastSignedAt == 0 means "never signed" (block.timestamp is never 0): an exact sentinel check
        // slither-disable-next-line incorrect-equality
        if (last == 0) {
            ++_uniqueVisitors;
        } else if (nowTs < last + COOLDOWN) {
            revert CooldownActive(last + COOLDOWN);
        }
        _lastSignedAt[visitorId] = nowTs;

        id = _entries.length;
        _entries.push(Entry({visitorId: visitorId, timestamp: nowTs, kind: kind, hidden: false, message: message}));
        // the only external calls upstream are staticcalls (ERC-1271, P-256 precompile), which cannot reenter
        // forge-lint: disable-next-line(reentrancy-events)
        emit Signed(id, visitorId, kind, message, nowTs);
    }

    /// @dev Visitor id for an address; shared by every path so they share one cooldown.
    function _visitorId(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function _view(uint256 id) private view returns (EntryView memory) {
        Entry storage e = _entries[id];
        return EntryView({
            id: id, visitorId: e.visitorId, timestamp: e.timestamp, kind: e.kind, hidden: e.hidden, message: e.message
        });
    }
}
