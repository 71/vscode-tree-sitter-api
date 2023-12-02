#!/usr/bin/env -S deno run --allow-read=. --allow-write=api.d.ts,data,out --allow-run=../node_modules/tree-sitter-cli/tree-sitter,node_modules/tree-sitter-cli/tree-sitter.exe --allow-net=codeload.github.com,github.com

import { JSZip } from "https://deno.land/x/jszip@0.11.0/mod.ts";

function printUsageAndExit(): never {
  console.error(
    `usage: ${Deno.mainModule} [--all] [--build-wasm] [--update-dts] [--update-text-objects]`,
  );
  Deno.exit(1);
}

if (Deno.args.length === 0) {
  printUsageAndExit();
}

const tasks = new Set<() => Promise<void>>();

for (const arg of Deno.args) {
  if (arg === "--all") {
    tasks.add(buildWasm);
    tasks.add(updateDts);
    tasks.add(updateTextObjects);
  } else if (arg === "--build-wasm") {
    tasks.add(buildWasm);
  } else if (arg === "--update-dts") {
    tasks.add(updateDts);
  } else if (arg === "--update-text-objects") {
    tasks.add(updateTextObjects);
  } else {
    console.error(`unknown argument: ${arg}\n\n`);
    printUsageAndExit();
  }
}

const outDir = new URL("out", import.meta.url).pathname;

await Deno.mkdir(outDir).catch(() => {});
await Promise.all(Array.from(tasks, (runTask) => runTask()));

async function buildWasm() {
  const treeSitterCli = addExe("../node_modules/tree-sitter-cli/tree-sitter");

  const buildPackage = async (pkg: string, path: string = pkg) => {
    const command = new Deno.Command(treeSitterCli, {
      args: [
        "build-wasm",
        `../node_modules/${path}`,
      ],
      cwd: outDir,
    });
    const child = command.spawn();
    const status = await child.status;

    if (!status.success) {
      throw new Error(`command failed with status ${status.code}`);
    }
  };
  const packages = await treeSitterPackages();

  await Promise.all(
    [
      ...packages.filter((pkg) => pkg !== "tree-sitter-typescript").map((pkg) =>
        buildPackage(pkg)
      ),
      buildPackage(
        "tree-sitter-typescript",
        "tree-sitter-typescript/typescript",
      ),
      buildPackage("tree-sitter-tsx", "tree-sitter-typescript/tsx"),
    ],
  );
}

async function updateDts() {
  const dtsContents = await Deno.readTextFile("out/extension.d.ts");
  const fixedDtsContents = dtsContents.replace(
    /^\/\*\*[\s\S]+?export declare function activate.+$/m,
    "",
  );
  await Deno.writeTextFile("api.d.ts", fixedDtsContents);
}

async function updateTextObjects() {
  const helixVersion = "23.10";
  const resp = await fetch(
    `https://github.com/helix-editor/helix/archive/refs/tags/${helixVersion}.zip`,
  );
  const data = await resp.arrayBuffer();
  const zip = await new JSZip().loadAsync(data);
  const languages = await treeSitterLanguages();

  async function loadResolvingInherited(
    language: string,
  ): Promise<string | undefined> {
    const path =
      `helix-${helixVersion}/runtime/queries/${language}/textobjects.scm`;
    const zipFile = zip.file(path);

    if (zipFile === null) {
      return;
    }

    const contents = await zipFile.async("string");
    const inheritsMatch = /^; inherits: ([\w,-]+)/m.exec(contents);

    if (inheritsMatch === null) {
      return contents;
    }

    const inherits = inheritsMatch[1].split(",");
    const inheritedContents = await Promise.all(
      inherits.map(async (inherited) => {
        const inheritedContents = await loadResolvingInherited(inherited);

        if (inheritedContents === undefined) {
          const languageExists =
            zip.folder(path.replace("/textobjects.scm", "")) !== null;

          if (!languageExists) {
            console.warn(
              `query file for language '${language}' inherits unknown language '${inherited}'`,
            );
          }

          return "";
        }

        return inheritedContents;
      }),
    );

    return inheritedContents.join("\n") + "\n" + contents;
  }

  Promise.all(languages.map(async (language) => {
    const textObjects = await loadResolvingInherited(language);

    if (textObjects !== undefined) {
      await Deno.writeTextFile(
        `${outDir}/textobjects-${language}.scm`,
        textObjects,
      );
    }
  }));
}

function addExe(binaryPath: string): string {
  return Deno.build.os === "windows" ? `${binaryPath}.exe` : binaryPath;
}

async function treeSitterPackages(): Promise<string[]> {
  const { default: packageJson } = await import("./package.json", {
    with: { type: "json" },
  });

  return Object.keys(packageJson.devDependencies).filter((k) =>
    k.startsWith("tree-sitter-") && k !== "tree-sitter-cli"
  );
}

async function treeSitterLanguages(): Promise<string[]> {
  const packages = await treeSitterPackages();

  return packages.map((pkg) => pkg.replace("tree-sitter-", "")).concat("tsx");
}
