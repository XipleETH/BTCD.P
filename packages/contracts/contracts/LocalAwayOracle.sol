// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Local/Away Oracle - Push-based oracle for net home-away goals index
/// @notice Index starts at 10000 (scaled 1e8) and moves by +1 on home goals and -1 on away goals aggregated.
///         Enforces strictly positive values. Off-chain daemon computes index and pushes.
contract LocalAwayOracle {
    error NotUpdater();

    event UpdaterSet(address indexed updater, bool allowed);
    event PriceUpdated(int256 price, uint256 timestamp);

    address public owner;
    mapping(address => bool) public isUpdater;
    // Index scaled to 1e8, must remain > 0
    int256 public latestAnswer;
    uint256 public latestTimestamp;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyUpdater() {
        if (!isUpdater[msg.sender]) revert NotUpdater();
        _;
    }

    constructor(address _owner, int256 _initialPrice) {
        require(_initialPrice > 0, "init <= 0");
        owner = _owner;
        latestAnswer = _initialPrice;
        latestTimestamp = block.timestamp;
    }

    function setUpdater(address _updater, bool _allowed) external onlyOwner {
        isUpdater[_updater] = _allowed;
        emit UpdaterSet(_updater, _allowed);
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        owner = _newOwner;
    }

    function pushPrice(int256 _price) external onlyUpdater {
        require(_price > 0, "price <= 0");
        latestAnswer = _price;
        latestTimestamp = block.timestamp;
        emit PriceUpdated(_price, latestTimestamp);
    }

    function decimals() external pure returns (uint8) { return 8; }
}
