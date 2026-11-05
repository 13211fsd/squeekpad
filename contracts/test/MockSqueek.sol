// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Test-only stand-in for the Squeek NFT collection: just balanceOf.
contract MockSqueek {
    mapping(address => uint256) public balanceOf;

    function setBalance(address who, uint256 b) external {
        balanceOf[who] = b;
    }
}

/// @dev Test-only receiver that rejects ETH, to check refunds/sends revert cleanly.
contract Rejector {
    function callPad(address pad, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = pad.call{value: msg.value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
}
