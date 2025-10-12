import { expect } from "chai";
import { ethers } from "hardhat";

describe("BTCD Perps", function() {
  it("open/close long", async () => {
    const [owner, trader] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("BTCDOracle");
    const oracle = await Oracle.deploy(owner.address);
    await oracle.waitForDeployment();
    await oracle.setUpdater(owner.address, true);
    await oracle.pushPrice(ethers.parseUnits("60", 8));

    const Perps = await ethers.getContractFactory("BTCDPerps");
  const perps = await Perps.deploy(await oracle.getAddress());
    await perps.waitForDeployment();

  await (perps as any).connect(trader).openPosition(true, 10, { value: ethers.parseEther("1") });

  // fund contract to pay out PnL (prototype uses contract balance as counterparty)
  await owner.sendTransaction({ to: await perps.getAddress(), value: ethers.parseEther("2") })

    // move price up
    await oracle.pushPrice(ethers.parseUnits("66", 8));

    const balBefore = await ethers.provider.getBalance(trader.address);
  const tx = await (perps as any).connect(trader).closePosition();
    const rcpt = await tx.wait();
    const gasUsed = rcpt!.gasUsed!;
    const effPrice = (rcpt as any).effectiveGasPrice as bigint | undefined;
    const gas = effPrice ? gasUsed * effPrice : 0n;
    const balAfter = await ethers.provider.getBalance(trader.address);

    expect(balAfter + gas).to.be.gt(balBefore);
  });
});
