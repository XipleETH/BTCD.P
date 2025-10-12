// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Simple Perpetuals for BTC Dominance index (0-100)
/// @notice Educational prototype. Not audited. Do not use in production.
interface IBTCDOracle {
    function latestAnswer() external view returns (int256);
    function latestTimestamp() external view returns (uint256);
}

contract BTCDPerps {
    // Events
    event PositionOpened(address indexed trader, bool isLong, uint256 leverage, uint256 margin, uint256 entryPrice);
    event PositionClosed(address indexed trader, int256 pnl, uint256 exitPrice);
    event Liquidated(address indexed trader, int256 pnl, uint256 price);

    // Storage
    IBTCDOracle public oracle;
    address public owner;

    struct Position {
        bool isOpen;
        bool isLong;
        uint256 leverage; // 1..150
        uint256 margin;   // in wei (ETH); for Base, use ETH as collateral for simplicity
        uint256 entryPrice; // scaled 1e8
        uint256 lastUpdate;
    }

    mapping(address => Position) public positions;

    // Risk params
    uint256 public constant MAX_LEVERAGE = 150;
    uint256 public maintenanceMarginRatioBps = 625; // 6.25%
    uint256 public liquidationFeeBps = 50; // 0.50% of notional paid to liquidator
    uint256 public takerFeeBps = 10; // 0.10% of notional on open/close

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }

    constructor(address _oracle) {
        oracle = IBTCDOracle(_oracle);
        owner = msg.sender;
    }

    receive() external payable {}

    function setParams(uint256 _mmBps, uint256 _liqFeeBps, uint256 _takerFeeBps) external onlyOwner {
        require(_mmBps <= 2000, "mm too high");
        require(_liqFeeBps <= 500, "fee too high");
        require(_takerFeeBps <= 100, "fee too high");
        maintenanceMarginRatioBps = _mmBps;
        liquidationFeeBps = _liqFeeBps;
        takerFeeBps = _takerFeeBps;
    }

    function getPrice() public view returns (uint256) {
        int256 p = oracle.latestAnswer();
        require(p >= 0, "bad price");
        return uint256(p);
    }

    function openPosition(bool isLong, uint256 leverage) external payable {
        require(leverage >= 1 && leverage <= MAX_LEVERAGE, "bad lev");
        require(msg.value > 0, "no margin");
        Position storage pos = positions[msg.sender];
        require(!pos.isOpen, "has pos");
        uint256 price = getPrice();
        uint256 notional = msg.value * leverage;
        uint256 fee = (notional * takerFeeBps) / 10000;
        require(address(this).balance >= fee, "insuff liq");
        // For prototype, fee remains in contract as protocol revenue.
        pos.isOpen = true;
        pos.isLong = isLong;
        pos.leverage = leverage;
        pos.margin = msg.value - fee;
        pos.entryPrice = price;
        pos.lastUpdate = block.timestamp;
        emit PositionOpened(msg.sender, isLong, leverage, pos.margin, price);
    }

    function closePosition() external {
        Position storage pos = positions[msg.sender];
        require(pos.isOpen, "no pos");
        uint256 price = getPrice();
        (int256 pnl, uint256 notional) = _calcPnl(pos, price);
        uint256 fee = (notional * takerFeeBps) / 10000;
        // close
        pos.isOpen = false;
        pos.lastUpdate = block.timestamp;

        int256 settle = int256(pos.margin) + pnl - int256(fee);
        uint256 payout = settle <= 0 ? 0 : uint256(settle);
        (bool ok,) = msg.sender.call{value: payout}("");
        require(ok, "payout fail");
        emit PositionClosed(msg.sender, pnl - int256(fee), price);
    }

    function canLiquidate(address trader) public view returns (bool) {
        Position storage pos = positions[trader];
        if (!pos.isOpen) return false;
        uint256 price = getPrice();
        (int256 pnl, uint256 notional) = _calcPnl(pos, price);
        int256 equity = int256(pos.margin) + pnl;
        int256 maintenance = int256((notional * maintenanceMarginRatioBps) / 10000);
        return equity <= maintenance;
    }

    function liquidate(address trader) external {
        Position storage pos = positions[trader];
        require(pos.isOpen, "no pos");
        require(canLiquidate(trader), "healthy");
        uint256 price = getPrice();
        (int256 pnl, uint256 notional) = _calcPnl(pos, price);
        pos.isOpen = false;
        int256 equity = int256(pos.margin) + pnl;
        uint256 liqFee = (notional * liquidationFeeBps) / 10000;
        uint256 reward = equity <= 0 ? 0 : uint256(equity) > liqFee ? liqFee : uint256(equity);
        if (reward > 0) {
            (bool ok,) = msg.sender.call{value: reward}("");
            require(ok, "liq fee fail");
        }
        emit Liquidated(trader, pnl, price);
    }

    function _calcPnl(Position storage pos, uint256 price) internal view returns (int256 pnl, uint256 notional) {
        // Linear PnL on percentage index: PnL = positionSize * (price - entry)/entry
        // positionSize = margin * leverage
        notional = pos.margin * pos.leverage;
        if (pos.entryPrice == 0) return (0, notional);
        if (pos.isLong) {
            // pnl = notional * (price - entry) / entry
            pnl = int256((notional * (price - pos.entryPrice)) / pos.entryPrice);
        } else {
            pnl = int256((notional * (pos.entryPrice - price)) / pos.entryPrice);
        }
    }
}
