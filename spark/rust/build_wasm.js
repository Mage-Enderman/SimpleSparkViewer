const { execSync } = await import("node:child_process");
const { platform } = await import("node:os");

const isWindows = platform() === "win32";

try {
  if (isWindows) {
    const output = execSync(
      "powershell.exe -ExecutionPolicy Bypass -File ./rust/build_rust_wasm.ps1",
      { stdio: "inherit" },
    );
  } else {
    execSync("rust/build_rust_wasm.sh", { stdio: "inherit" });
  }
} catch (err) {
  console.error("Failed to build RUST WASM:", err.message);
  process.exit(1);
}
