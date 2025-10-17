// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Random Oracle - Push-based oracle for synthetic random walk index
/// @notice Same interface shape as BTCDOracle but without 0..100 range bound.
///         Intended to be fed by an off-chain daemon every second with +-0.1% changes.
contract RandomOracle {
    error NotUpdater();

    event UpdaterSet(address indexed updater, bool allowed);
    event PriceUpdated(int256 price, uint256 timestamp);

    address public owner;
    mapping(address => bool) public isUpdater;
    // Price is scaled to 1e8, arbitrary positive domain (e.g., start 1000e8)
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
