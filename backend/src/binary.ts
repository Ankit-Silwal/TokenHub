import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
const require = createRequire(import.meta.url);
// Resolve the pinned package's native executable so cancellation kills Codex itself,
// including on Windows, instead of only terminating the npm JavaScript wrapper.
export function codexBinary() {
  const cpu =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : null;
  const suffix = {
    linux: "unknown-linux-musl",
    darwin: "apple-darwin",
    win32: "pc-windows-msvc",
  }[process.platform as string];
  if (!cpu || !suffix) throw new Error("Unsupported Codex platform.");
  const platformPackage =
    "@openai/codex-" + process.platform + "-" + process.arch;
  let root: string;
  try {
    root = dirname(require.resolve(platformPackage + "/package.json"));
  } catch {
    root = dirname(require.resolve("@openai/codex/package.json"));
  }
  const path = join(
    root,
    "vendor",
    cpu + "-" + suffix,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (!existsSync(path))
    throw new Error(
      "Codex native dependency is missing. Run npm install with optional dependencies.",
    );
  return path;
}
