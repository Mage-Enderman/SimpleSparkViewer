import fs from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const examplesDirectory = "docs/examples";
if (fs.existsSync(examplesDirectory)) {
  await rm(examplesDirectory, { recursive: true, force: true });
  console.log(`Directory ${examplesDirectory} deleted`);
}

const distDirectory = "docs/dist";
if (fs.existsSync(distDirectory)) {
  await rm(distDirectory, { recursive: true, force: true });
  console.log(`Directory ${distDirectory} deleted`);
}

const viewerDirectory = "docs/viewer";
if (fs.existsSync(viewerDirectory)) {
  await rm(viewerDirectory, { recursive: true, force: true });
  console.log(`Directory ${viewerDirectory} deleted`);
}
