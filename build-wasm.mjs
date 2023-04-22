import { copyFile, readFile, rm } from "fs/promises";
import { spawn } from "child_process";

/**
 * @type {import("./package.json")}
 */
const packageJson = JSON.parse(await readFile("package.json", "utf-8"));

const buildPackage = async (pkg, path = pkg) => {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [
      "node_modules/tree-sitter-cli/cli.js",
      "build-wasm",
      `node_modules/${path}`,
    ], { stdio: "inherit" });

    p.on(
      "close",
      (code) => code === 0 ? resolve() : reject("command failed"),
    );
  });

  await copyFile(`${pkg}.wasm`, `data/${pkg}.wasm`);
  await rm(`${pkg}.wasm`);
};

const packages = Object.keys(packageJson.devDependencies).filter((k) =>
  k.startsWith("tree-sitter-") && k !== "tree-sitter-cli" &&
  k !== "tree-sitter-typescript"
);

await Promise.all(
  packages.map((pkg) => buildPackage(pkg)),
  buildPackage("tree-sitter-typescript", "tree-sitter-typescript/typescript"),
  buildPackage("tree-sitter-tsx", "tree-sitter-typescript/tsx"),
);
