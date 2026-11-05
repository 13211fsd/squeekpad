// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC721Balance {
    function balanceOf(address owner) external view returns (uint256);
}

interface IUniswapV2Factory {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
}

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title SqueekPadToken
/// @notice Fixed-supply token launched on SqueekPad. Until its curve graduates, it can only move
///         to or from the pad, so nobody can seed the Uniswap pair early or trade off-curve.
contract SqueekPadToken is ERC20 {
    error OnlyPad();
    error TransfersLocked();

    address public immutable pad;
    address public immutable creator;
    string public description;
    bool public graduated;

    constructor(string memory name_, string memory symbol_, string memory description_, address creator_, uint256 supply)
        ERC20(name_, symbol_)
    {
        pad = msg.sender;
        creator = creator_;
        description = description_;
        _mint(msg.sender, supply);
    }

    function markGraduated() external {
        if (msg.sender != pad) revert OnlyPad();
        graduated = true;
    }

    /// @dev Lets the pad take tokens a holder sells back, so selling needs no separate approve.
    function padPull(address from, uint256 value) external {
        if (msg.sender != pad) revert OnlyPad();
        _transfer(from, pad, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && from != address(0) && from != pad && to != pad) revert TransfersLocked();
        super._update(from, to, value);
    }
}

/// @title SqueekPad
/// @notice Ownerless testnet launchpad for the Squeekchain community. Every launch trades on a
///         constant-product bonding curve in ETH. When 800M of its 1B tokens are sold, the curve
///         graduates: the raised ETH and the last 200M tokens become a Uniswap V2 pool whose LP is
///         burned. Squeek NFT holders trade with no fee; everyone else pays 1% to the token's creator.
contract SqueekPad is ReentrancyGuard {
    error BadParams();
    error UnknownToken();
    error AlreadyGraduated();
    error Slippage();
    error ZeroAmount();
    error TransferFailed();

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant LP_SUPPLY = 200_000_000e18;
    uint256 public constant VIRTUAL_TOKENS = 1_073_000_000e18;
    uint256 public constant FEE_BPS = 100; // 1%
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 public immutable virtualEth;
    IERC721Balance public immutable squeeks;
    IUniswapV2Factory public immutable uniFactory;
    IWETH public immutable weth;

    struct Curve {
        address creator;
        uint256 vEth;    // virtual ETH reserve (includes virtualEth)
        uint256 vTok;    // virtual token reserve
        uint256 realEth; // ETH actually held for this curve
        uint256 sold;    // tokens sold out of CURVE_SUPPLY
        address pair;    // set on graduation
        bool graduated;
        uint64 createdAt;
    }

    mapping(address token => Curve) public curves;
    address[] public allTokens;
    mapping(address creator => uint256) public creatorFees;

    event Launched(address indexed token, address indexed creator, string name, string symbol, string description);
    event Trade(
        address indexed token, address indexed trader, bool isBuy,
        uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 vEth, uint256 vTok
    );
    event Graduated(address indexed token, address indexed pair, uint256 ethAmount, uint256 tokenAmount, uint256 liquidity);
    event FeesClaimed(address indexed creator, uint256 amount);

    constructor(uint256 virtualEth_, address squeeks_, address uniFactory_, address weth_) {
        if (virtualEth_ == 0 || uniFactory_ == address(0) || weth_ == address(0)) revert BadParams();
        virtualEth = virtualEth_;
        squeeks = IERC721Balance(squeeks_);
        uniFactory = IUniswapV2Factory(uniFactory_);
        weth = IWETH(weth_);
    }

    // ------------------------------------------------------------------ launch

    function launch(string calldata name, string calldata symbol, string calldata description, uint256 minTokensOut)
        external payable nonReentrant returns (address token)
    {
        uint256 nl = bytes(name).length;
        uint256 sl = bytes(symbol).length;
        if (nl == 0 || nl > 32 || sl == 0 || sl > 10 || bytes(description).length > 280) revert BadParams();

        token = address(new SqueekPadToken(name, symbol, description, msg.sender, TOTAL_SUPPLY));
        curves[token] = Curve({
            creator: msg.sender, vEth: virtualEth, vTok: VIRTUAL_TOKENS, realEth: 0, sold: 0,
            pair: address(0), graduated: false, createdAt: uint64(block.timestamp)
        });
        allTokens.push(token);
        emit Launched(token, msg.sender, name, symbol, description);

        if (msg.value > 0) _buy(token, msg.value, minTokensOut);
    }

    // ------------------------------------------------------------------ trading

    function buy(address token, uint256 minTokensOut) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        _buy(token, msg.value, minTokensOut);
    }

    function sell(address token, uint256 tokenAmount, uint256 minEthOut) external nonReentrant {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
        if (tokenAmount == 0) revert ZeroAmount();

        uint256 gross = (c.vEth * tokenAmount) / (c.vTok + tokenAmount);
        if (gross > c.realEth) gross = c.realEth;
        uint256 fee = _feeFor(msg.sender, gross);
        uint256 net = gross - fee;
        if (net < minEthOut) revert Slippage();

        c.vTok += tokenAmount;
        c.vEth -= gross;
        c.realEth -= gross;
        c.sold -= tokenAmount;
        creatorFees[c.creator] += fee;

        SqueekPadToken(token).padPull(msg.sender, tokenAmount);
        emit Trade(token, msg.sender, false, gross, tokenAmount, fee, c.vEth, c.vTok);
        _sendEth(msg.sender, net);
    }

    function claimFees() external nonReentrant {
        uint256 amt = creatorFees[msg.sender];
        if (amt == 0) revert ZeroAmount();
        creatorFees[msg.sender] = 0;
        emit FeesClaimed(msg.sender, amt);
        _sendEth(msg.sender, amt);
    }

    // ------------------------------------------------------------------ views

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function feeBpsFor(address user) public view returns (uint256) {
        return _isSqueekHolder(user) ? 0 : FEE_BPS;
    }

    /// @notice Tokens out for `ethIn` sent by `user`, and the ETH actually used (the rest is refunded).
    function quoteBuy(address token, uint256 ethIn, address user) external view returns (uint256 tokensOut, uint256 ethUsed) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.graduated) return (0, 0);
        uint256 bps = feeBpsFor(user);
        uint256 fee = (ethIn * bps) / 10_000;
        (tokensOut, ethUsed) = _curveBuy(c, ethIn - fee, bps);
    }

    function quoteSell(address token, uint256 tokenAmount, address user) external view returns (uint256 ethOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.graduated) return 0;
        uint256 gross = (c.vEth * tokenAmount) / (c.vTok + tokenAmount);
        if (gross > c.realEth) gross = c.realEth;
        ethOut = gross - (gross * feeBpsFor(user)) / 10_000;
    }

    // ------------------------------------------------------------------ internals

    /// @return out tokens bought; used total ETH (net + fee) consumed
    function _curveBuy(Curve storage c, uint256 net, uint256 bps) private view returns (uint256 out, uint256 used) {
        uint256 remaining = CURVE_SUPPLY - c.sold;
        out = (c.vTok * net) / (c.vEth + net);
        if (out >= remaining) {
            out = remaining;
            // smallest net that buys `remaining`, rounded up so k never shrinks
            net = (c.vEth * out + (c.vTok - out) - 1) / (c.vTok - out);
        }
        uint256 fee = bps == 0 ? 0 : (net * bps + (10_000 - bps) - 1) / (10_000 - bps);
        used = net + fee;
    }

    function _buy(address token, uint256 ethIn, uint256 minTokensOut) private {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();

        uint256 bps = feeBpsFor(msg.sender);
        uint256 fee = (ethIn * bps) / 10_000;
        uint256 net = ethIn - fee;
        uint256 remaining = CURVE_SUPPLY - c.sold;
        uint256 out = (c.vTok * net) / (c.vEth + net);
        uint256 refund;
        if (out >= remaining) {
            out = remaining;
            net = (c.vEth * out + (c.vTok - out) - 1) / (c.vTok - out);
            fee = bps == 0 ? 0 : (net * bps + (10_000 - bps) - 1) / (10_000 - bps);
            refund = ethIn - net - fee;
        }
        if (out == 0) revert ZeroAmount();
        if (out < minTokensOut) revert Slippage();

        c.vEth += net;
        c.vTok -= out;
        c.realEth += net;
        c.sold += out;
        creatorFees[c.creator] += fee;

        SqueekPadToken(token).transfer(msg.sender, out);
        emit Trade(token, msg.sender, true, net, out, fee, c.vEth, c.vTok);

        if (c.sold == CURVE_SUPPLY) _graduate(token, c);
        if (refund > 0) _sendEth(msg.sender, refund);
    }

    function _graduate(address token, Curve storage c) private {
        c.graduated = true;
        SqueekPadToken(token).markGraduated();

        address pair = uniFactory.getPair(token, address(weth));
        if (pair == address(0)) pair = uniFactory.createPair(token, address(weth));
        c.pair = pair;

        uint256 ethAmt = c.realEth;
        c.realEth = 0;
        weth.deposit{value: ethAmt}();
        if (!weth.transfer(pair, ethAmt)) revert TransferFailed();
        SqueekPadToken(token).transfer(pair, LP_SUPPLY);
        uint256 liq = IUniswapV2Pair(pair).mint(DEAD); // LP burned: liquidity is permanent

        emit Graduated(token, pair, ethAmt, LP_SUPPLY, liq);
    }

    function _feeFor(address user, uint256 amount) private view returns (uint256) {
        return (amount * feeBpsFor(user)) / 10_000;
    }

    function _isSqueekHolder(address user) private view returns (bool) {
        if (address(squeeks).code.length == 0) return false; // try/catch can't catch calls to codeless addresses
        try squeeks.balanceOf(user) returns (uint256 b) {
            return b > 0;
        } catch {
            return false;
        }
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
