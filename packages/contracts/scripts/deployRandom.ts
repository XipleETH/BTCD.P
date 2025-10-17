import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const initial = BigInt(1000n * 10n ** 8n); // 1000.00000000 scaled 1e8
  const Oracle = await ethers.getContractFactory("RandomOracle");
  const oracle = await Oracle.deploy(deployer.address, initial);
  await oracle.waitForDeployment();
  console.log("Random Oracle:", await oracle.getAddress());

  const Perps = await ethers.getContractFactory("BTCDPerps");
  const perps = await Perps.deploy(await oracle.getAddress());
  await perps.waitForDeployment();
  console.log("Perps (Random):", await perps.getAddress());

  const tx = await oracle.setUpdater(deployer.address, true);
  await tx.wait();
  console.log("Updater set");

  const out = {
    network: network.name,
    oracle: await oracle.getAddress(),
    perps: await perps.getAddress(),
    deployer: deployer.address,
    kind: 'random',
    timestamp: Date.now()
  };
  const dir = path.join(process.cwd());
  const jsonPath = path.join(dir, `addresses.random.${network.name}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  const envSnippet = `RANDOM_ORACLE=${out.oracle}\nRANDOM_PERPS=${out.perps}\n`;
  fs.writeFileSync(path.join(dir, ".env.random"), envSnippet);
  console.log("Saved addresses to:", jsonPath, "and .env.random");
}

main().catch((e) => { console.error(e); process.exit(1); });
