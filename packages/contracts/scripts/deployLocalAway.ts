import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Local/Away with:", deployer.address);

  const initial = 10000n * 10n ** 8n; // 10000.00000000 scaled 1e8
  const Oracle = await ethers.getContractFactory("LocalAwayOracle");
  const oracle = await Oracle.deploy(deployer.address, initial);
  await oracle.waitForDeployment();
  console.log("LocalAway Oracle:", await oracle.getAddress());

  const Perps = await ethers.getContractFactory("LocalAwayPerps");
  const perps = await Perps.deploy(await oracle.getAddress());
  await perps.waitForDeployment();
  console.log("Perps (LocalAway):", await perps.getAddress());

  const tx = await oracle.setUpdater(deployer.address, true);
  await tx.wait();
  console.log("Updater set");

  const out = {
    network: network.name,
    oracle: await oracle.getAddress(),
    perps: await perps.getAddress(),
    deployer: deployer.address,
    kind: 'localaway',
    timestamp: Date.now()
  };
  const dir = path.join(process.cwd());
  const jsonPath = path.join(dir, `addresses.localaway.${network.name}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  const envSnippet = `LOCALAWAY_ORACLE=${out.oracle}\nLOCALAWAY_PERPS=${out.perps}\n`;
  fs.writeFileSync(path.join(dir, ".env.localaway"), envSnippet);
  console.log("Saved addresses to:", jsonPath, "and .env.localaway");
}

main().catch((e) => { console.error(e); process.exit(1); });
