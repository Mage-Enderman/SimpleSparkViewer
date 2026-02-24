import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
const siteDirectory = "site";

if (existsSync(siteDirectory)) {
  await rm(siteDirectory, { recursive: true, force: true });
  console.log(`Directory ${siteDirectory} deleted`);
}
