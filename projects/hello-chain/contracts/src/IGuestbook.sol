// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IGuestbook
/// @notice Shared types, events and errors for the on-chain guestbook.
interface IGuestbook {
    /// @notice How an entry was authorised.
    enum Kind {
        Direct,
        Wallet,
        Passkey
    }

    /// @notice Read-side representation of a guestbook entry.
    /// @param id Position of the entry in the append-only log.
    /// @param visitorId Opaque visitor identifier (an address left-padded to 32 bytes for Direct/Wallet).
    /// @param timestamp Block timestamp at which the entry was recorded.
    /// @param kind Authorisation path used.
    /// @param hidden Whether the owner has hidden the entry from the default view.
    /// @param message The message text (1-140 bytes).
    struct EntryView {
        uint256 id;
        bytes32 visitorId;
        uint40 timestamp;
        Kind kind;
        bool hidden;
        string message;
    }

    /// @notice The message is empty.
    error MessageEmpty();
    /// @notice The message exceeds the maximum byte length.
    /// @param length The offending length in bytes.
    error MessageTooLong(uint256 length);
    /// @notice The visitor signed too recently.
    /// @param until Timestamp at which the visitor may sign again.
    error CooldownActive(uint40 until);
    /// @notice A signed request is past its deadline.
    error SignatureExpired();
    /// @notice A signature failed verification.
    error InvalidSignature();
    /// @notice A requested page is larger than the maximum page size.
    /// @param limit The requested page size.
    error PageTooLarge(uint256 limit);
    /// @notice No entry exists with the given id.
    /// @param id The requested id.
    error EntryNotFound(uint256 id);
    /// @notice The deploy-time cooldown is outside the allowed range.
    /// @param cooldown The rejected cooldown in seconds.
    error CooldownOutOfRange(uint40 cooldown);
    /// @notice Renouncing ownership is disabled: an ownerless guestbook could never hide abuse again.
    error RenounceDisabled();

    /// @notice Emitted when an entry is recorded.
    /// @param id Entry id.
    /// @param visitorId Visitor identifier.
    /// @param kind Authorisation path used.
    /// @param message The message text.
    /// @param timestamp Block timestamp of the entry.
    event Signed(uint256 indexed id, bytes32 indexed visitorId, Kind kind, string message, uint40 timestamp);

    /// @notice Emitted when the owner changes an entry's hidden flag.
    /// @param id Entry id.
    /// @param hidden New hidden state.
    event HiddenSet(uint256 indexed id, bool hidden);
}
