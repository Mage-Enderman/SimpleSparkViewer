import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
const assetsDirectory = "examples/assets/";

if (existsSync(assetsDirectory)) {
  await rm(assetsDirectory, { recursive: true, force: true });
  console.log(`Directory ${assetsDirectory} deleted`);
}
