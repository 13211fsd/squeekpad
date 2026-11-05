// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ISqueekPadToken {
    function pad() external view returns (address);
    function creator() external view returns (address);
}

/// @title SqueekPadImages
/// @notice Lets the creator of a SqueekPad coin attach a small image to it, fully onchain.
///         The image bytes live only in the event log (cheap), so the site rebuilds images
///         from `ImageSet` logs. The latest image set by the creator wins.
contract SqueekPadImages {
    error NotCreator();
    error BadImage();

    uint256 public constant MAX_BYTES = 24_000;

    address public immutable pad;

    event ImageSet(address indexed token, address indexed creator, string mime, bytes data);

    constructor(address pad_) {
        pad = pad_;
    }

    /// @param mime "image/webp", "image/png" or "image/jpeg"
    function setImage(address token, string calldata mime, bytes calldata data) external {
        if (token.code.length == 0) revert NotCreator();
        if (ISqueekPadToken(token).pad() != pad || ISqueekPadToken(token).creator() != msg.sender) revert NotCreator();
        bytes32 m = keccak256(bytes(mime));
        if (
            data.length == 0 || data.length > MAX_BYTES
                || (m != keccak256("image/webp") && m != keccak256("image/png") && m != keccak256("image/jpeg"))
        ) revert BadImage();
        emit ImageSet(token, msg.sender, mime, data);
    }
}
