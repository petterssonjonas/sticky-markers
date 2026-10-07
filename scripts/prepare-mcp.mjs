import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
const debug = process.argv.includes("--debug");
const target =
  process.env.STICKY_BUILD_TARGET ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host: "))
    ?.slice(6);
if (!target) throw new Error("Could not determine Rust build target");
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "sticky-markers-mcp",
    ...(debug ? [] : ["--release"]),
    ...(process.env.STICKY_BUILD_TARGET ? ["--target", target] : []),
  ],
  { stdio: "inherit" },
);
const ext = target.includes("windows") ? ".exe" : "";
const profile = debug ? "debug" : "release";
mkdirSync("src-tauri/binaries", { recursive: true });
copyFileSync(
  `target/${process.env.STICKY_BUILD_TARGET ? target + "/" : ""}${profile}/sticky-markers-mcp${ext}`,
  `src-tauri/binaries/sticky-markers-mcp-${target}${ext}`,
);
console.log(`Prepared ${target} MCP executable for packaging`);
