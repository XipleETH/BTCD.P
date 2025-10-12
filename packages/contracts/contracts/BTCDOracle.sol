// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BTCD Oracle - Push-based admin oracle for BTC Dominance (0-100 value scaled to 1e8)
/// @notice For production use a decentralized oracle (Chainlink/UMA/Pyth). This is a stub with roles.
contract BTCDOracle {
    error NotUpdater();

    event UpdaterSet(address indexed updater, bool allowed);
    event PriceUpdated(int256 price, uint256 timestamp);

    address public owner;
    mapping(address => bool) public isUpdater;
    // Price is scaled to 1e8 (like Chainlink), representing percentage 0-100
    // e.g., 60.12345678% => 6_012_345_678
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

    constructor(address _owner) {
        owner = _owner;
    }

    function setUpdater(address _updater, bool _allowed) external onlyOwner {
        isUpdater[_updater] = _allowed;
        emit UpdaterSet(_updater, _allowed);
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        owner = _newOwner;
    }

    function pushPrice(int256 _price) external onlyUpdater {
        // bounds: -1 to 100 (scaled) theoretically; allow 0..100 inclusive
        require(_price >= 0 && _price <= 100e8, "out of range");
        latestAnswer = _price;
        latestTimestamp = block.timestamp;
        emit PriceUpdated(_price, latestTimestamp);
    }

    function decimals() external pure returns (uint8) { return 8; }
}
