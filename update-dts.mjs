import { readFile, writeFile } from "fs/promises";

const dtsContents = await readFile("out/extension.d.ts", "utf-8");
const fixedDtsContents = dtsContents.replace(
  /^\/\*\*[\s\S]+?export declare function activate.+$/m,
  "",
);
await writeFile("api.d.ts", fixedDtsContents, "utf-8");
