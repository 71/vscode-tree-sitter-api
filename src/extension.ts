import * as vscode from "vscode";
import TreeSitter, { Query, SyntaxNode, Tree } from "web-tree-sitter";

export { Query, type SyntaxNode, type Tree, TreeSitter };

import TreeSitterWasm from "web-tree-sitter/tree-sitter.wasm";

import TreeSitterC from "../data/tree-sitter-c.wasm";
import TreeSitterCpp from "../data/tree-sitter-cpp.wasm";
import TreeSitterGo from "../data/tree-sitter-go.wasm";
import TreeSitterHtml from "../data/tree-sitter-html.wasm";
import TreeSitterJavascript from "../data/tree-sitter-javascript.wasm";
import TreeSitterPython from "../data/tree-sitter-python.wasm";
import TreeSitterRust from "../data/tree-sitter-rust.wasm";
import TreeSitterTypescript from "../data/tree-sitter-typescript.wasm";
import TreeSitterTsx from "../data/tree-sitter-tsx.wasm";

/**
 * The cache of parsed trees per document. Note that this cache is shared
 * between all `Cache`s. As of 2023-04-22, the API does not provide access to
 * the underlying Tree Sitter values and objects are either immutable (like
 * {@link DocumentTree}) or generated on-demand (like
 * {@link TreeSitter.Tree.rootNode}), so there is no value in storing different
 * copies for each cache. In case this changes in the future, we provide
 * different `Cache` instances to clients.
 */
const documentCache = new Map<vscode.TextDocument, {
  tree: TreeSitter.Tree;
  /**
   * The time this entry became dirty (e.g. changed, invalidating `tree`). If
   * `0`, the entry is up to date.
   */
  dirtyTimestamp: number;
}>();

let extensionContext: vscode.ExtensionContext;

/**
 * Publicly exported API available with
 * `vscode.extensions.getExtension(...).activate()`.
 */
export type API = Omit<typeof import("./extension"), "activate">;

/**
 * Activation function called by VS Code.
 */
export function activate(
  context: vscode.ExtensionContext,
): API {
  let inspectScopesSubscription: vscode.Disposable | undefined;

  extensionContext = context;

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Invalidate cache on each change.
      const state = documentCache.get(e.document);

      if (state !== undefined) {
        const now = Date.now();

        if (state.dirtyTimestamp === 0) {
          state.dirtyTimestamp = now;
        } else if (state.dirtyTimestamp + 120_000) {
          // The state hasn't been requested in 2 minutes, we can discard it.
          state.tree.delete();
          documentCache.delete(e.document);
        }
      }
    }),
    vscode.workspace.onDidCloseTextDocument((e) => {
      // Stop tracking closed text documents.
      const state = documentCache.get(e);

      if (state !== undefined) {
        state.tree.delete();
        documentCache.delete(e);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      const isActiveEditorSupported = e !== undefined &&
        determineLanguage(e.document) !== undefined;

      vscode.commands.executeCommand(
        "setContext",
        "tree-sitter.activeEditorIsSupported",
        isActiveEditorSupported,
      );
    }),
    vscode.commands.registerCommand("tree-sitter.inspect-scopes", () => {
      if (inspectScopesSubscription !== undefined) {
        inspectScopesSubscription.dispose();
        inspectScopesSubscription = undefined;

        return;
      }

      const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
      );
      item.command = "tree-sitter.inspect-scopes";

      const cache = new Cache();
      let cts: vscode.CancellationTokenSource | undefined;

      const updateItem = () => {
        if (cts !== undefined) {
          cts.dispose();
        }

        cts = new vscode.CancellationTokenSource();
        const token = cts.token;

        (async (): Promise<
          undefined | string | [text: string, tooltip: string]
        > => {
          const editor = vscode.window.activeTextEditor;

          if (editor === undefined) {
            return;
          }

          const document = editor.document;

          try {
            return await withDocumentTree(document, { cache }, (tree) => {
              if (token.isCancellationRequested) {
                return;
              }

              const activePosition = editor.selection.active;
              const closestNode = tree.rootNode.descendantForPosition(
                fromPosition(activePosition),
              );
              const scopes: string[] = [];

              for (
                let node: SyntaxNode | null = closestNode;
                node !== null;
                node = node.parent
              ) {
                scopes.push(node.type);
              }

              return [scopes[0], scopes.reverse().join("\n")];
            });
          } catch (e) {
            return ["<cannot load tree>", `${e}`];
          }
        })().then((texts) => {
          if (texts === undefined) {
            item.hide();

            return;
          }

          const [text, tooltip] = Array.isArray(texts)
            ? texts
            : [texts, undefined];

          item.text = `$(list-filter) ${text}`;
          item.tooltip = tooltip === undefined
            ? undefined
            : new vscode.MarkdownString(
              "Tree Sitter scopes\n\n" +
                "-----\n\n" +
                tooltip.replace(/\n/g, "  \n"),
            );

          item.show();
        });
      };

      const subscriptions = [
        vscode.window.onDidChangeActiveTextEditor(() => updateItem()),
        vscode.window.onDidChangeTextEditorSelection(() => updateItem()),
        vscode.workspace.onDidChangeTextDocument((e) => {
          if (vscode.window.activeTextEditor?.document === e.document) {
            updateItem();
          }
        }),
      ];

      inspectScopesSubscription = {
        dispose() {
          item.dispose();

          for (const subscription of subscriptions) {
            subscription.dispose();
          }
        },
      };

      updateItem();
    }),
    {
      dispose() {
        // Dynamic subscriptions.
        inspectScopesSubscription?.dispose();
        inspectScopesSubscription = undefined;

        // Clear cache.
        for (const key in loadedLanguages) {
          delete loadedLanguages[key as Language];
        }

        for (const { tree } of documentCache.values()) {
          tree.delete();
        }

        documentCache.clear();

        // Unfortunately, we can't dispose of the cache maintained within
        // Tree Sitter itself.
      },
    },
  );

  // Public API:
  return Object.freeze({
    Cache,
    determineLanguage,
    determineLanguageOrFail,
    documentTree,
    documentTreeSync,
    ensureLoaded,
    fromPosition,
    fromRange,
    Language,
    query,
    Query,
    querySync,
    toPosition,
    toRange,
    TreeSitter,
    using,
    withDocumentTree,
    withDocumentTreeSync,
    withQuery,
    withQuerySync,
  });
}

/**
 * A supported language.
 */
export enum Language {
  C = "c",
  Cpp = "cpp",
  Go = "go",
  Html = "html",
  JavaScript = "javascript",
  JavaScriptReact = "javascript",
  Python = "python",
  Rust = "rust",
  TypeScript = "typescript",
  TypeScriptReact = "tsx",
}

const allLanguages: readonly Language[] = Object.values(Language);

/**
 * Mapping from {@link Language} to the `.wasm` file that must be loaded for it.
 */
const languageWasmMap = Object.freeze({
  [Language.C]: TreeSitterC,
  [Language.Cpp]: TreeSitterCpp,
  [Language.Go]: TreeSitterGo,
  [Language.Html]: TreeSitterHtml,
  [Language.JavaScript]: TreeSitterJavascript,
  [Language.Python]: TreeSitterPython,
  [Language.Rust]: TreeSitterRust,
  [Language.TypeScript]: TreeSitterTypescript,
  [Language.TypeScriptReact]: TreeSitterTsx,
});

/**
 * Mapping from VS Code language ID to its corresponding {@link Language}.
 */
const knownLanguageIds: { [languageId: string]: Language } = Object.freeze({
  "c": Language.C,
  "cpp": Language.Cpp,
  "go": Language.Go,
  "html": Language.Html,
  "javascript": Language.JavaScript,
  "javascriptreact": Language.JavaScriptReact,
  "python": Language.Python,
  "rust": Language.Rust,
  "typescript": Language.TypeScript,
  "typescriptreact": Language.TypeScriptReact,
});

/**
 * Cache of loaded languages.
 */
const loadedLanguages: {
  [language in Language]?: TreeSitter.Language | Promise<TreeSitter.Language>;
} = {};

/**
 * Ensures that Tree Sitter is loaded.
 */
export async function ensureLoaded(): Promise<void>;

/**
 * Ensures that the specified language is loaded.
 */
export async function ensureLoaded(input: HasLanguage): Promise<void>;

export async function ensureLoaded(
  language?: HasLanguage,
): Promise<void> {
  if (TreeSitter.Language === undefined) {
    const wasmModule = await WebAssembly.compile(
      await vscode.workspace.fs.readFile(
        resolveWasmFilePath(TreeSitterWasm),
      ),
    );

    await TreeSitter.init({
      instantiateWasm(
        imports: WebAssembly.Imports,
        successCallback: (
          instance: WebAssembly.Instance,
          module: WebAssembly.Module,
        ) => void,
      ) {
        // https://emscripten.org/docs/api_reference/module.html#Module.instantiateWasm
        WebAssembly.instantiate(wasmModule, imports).then((instance) => {
          successCallback(instance, wasmModule);
        });

        return {};
      },
    });
  }

  if (language === undefined) {
    return;
  }

  const validLanguage = determineLanguageOrFail(language);

  if (loadedLanguages[validLanguage] === undefined) {
    const wasmFileBytes = await vscode.workspace.fs.readFile(
      resolveWasmFilePath(languageWasmMap[validLanguage]),
    );
    const languagePromise = TreeSitter.Language.load(
      wasmFileBytes,
    ).then((l) => loadedLanguages[validLanguage] = l);

    loadedLanguages[validLanguage] = languagePromise;
  }

  await loadedLanguages[validLanguage];
}

/**
 * Type from which a {@link Language} can be determined.
 */
export type HasLanguage =
  | Language
  | string
  | vscode.Uri
  | vscode.TextDocument;

/**
 * Returns the {@link Language} of the file at the given value if it can be
 * reliably determined. Otherwise, returns `undefined`.
 */
export function determineLanguage(
  input: HasLanguage,
): Language | undefined {
  if (typeof input === "object" && input !== null) {
    if (input instanceof vscode.Uri) {
      input = input.path;
    } else {
      const knownLanguage = knownLanguageIds[input.languageId];

      if (knownLanguage !== undefined) {
        return knownLanguage;
      }

      input = input.uri.path;
    }
  }

  if (typeof input !== "string") {
    throw new TypeError("input must be an Uri, TextDocument, or string");
  }

  if (allLanguages.includes(input as Language)) {
    return input as Language;
  }

  if (input.endsWith(".c")) {
    return Language.C;
  }

  if (/\.c(c|pp)|\.h(|h|pp)$/.test(input)) {
    return Language.Cpp;
  }

  if (input.endsWith(".go")) {
    return Language.Go;
  }

  if (input.endsWith(".html")) {
    return Language.Html;
  }

  if (/\.[cm]?jsx?$/.test(input)) {
    return input.endsWith("x") ? Language.JavaScriptReact : Language.JavaScript;
  }

  if (input.endsWith(".py")) {
    return Language.Python;
  }

  if (input.endsWith(".rs")) {
    return Language.Rust;
  }

  if (/\.[cm]?tsx?$/.test(input)) {
    return input.endsWith("x") ? Language.TypeScriptReact : Language.TypeScript;
  }

  return undefined;
}

/**
 * Same as {@link determineLanguage()}, but throws an error on failure instead
 * of returning `undefined`.
 */
export function determineLanguageOrFail(input: HasLanguage): Language {
  const result = determineLanguage(input);

  if (result === undefined) {
    throw new Error(`cannot determine language for file "${input}"`);
  }

  return result;
}

/**
 * A cache for trees returned by {@link documentTree()} and
 * {@link documentTreeSync()}.
 */
export class Cache {
  // The cache does not store anything; it is only used as a key for the global
  // cache.
  //
  // The reason why we have individual `Cache`s _and_ a global cache is that
  // each caller may mutate the returned trees, and keying by `Cache` instance
  // allows us to return different trees to different callers. It is also easier
  // to keep track of all active documents this way.

  public constructor() {
    Object.freeze(this);
  }
}

/**
 * Options given to {@link documentTree()} and {@link documentTreeSync()}.
 */
export interface DocumentTreeOptions {
  /**
   * The language to use; if unspecified, it will be determined using
   * {@link determineLanguage()}.
   */
  readonly language?: Language;

  /**
   * The cache used to resolve the tree, or `undefined` if no cache should be
   * used.
   */
  readonly cache?: Cache;

  /**
   * The timeout in milliseconds of the operation.
   */
  readonly timeoutMs?: number;
}

/**
 * Returns the document tree for the specified document,
 * {@link ensureLoaded loading} the necessary code first if necessary.
 */
export async function documentTree(
  document: vscode.TextDocument,
  options: DocumentTreeOptions = {},
): Promise<Tree> {
  const deadline =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? Date.now() + options.timeoutMs
      : undefined;

  await ensureLoaded(document);

  if (deadline !== undefined) {
    const now = Date.now();

    if (now >= deadline) {
      throw new Error("timeout");
    }

    options = { ...options, timeoutMs: now - deadline };
  }

  return documentTreeSync(document, options);
}

/**
 * Returns the document tree for the specified document, failing if the
 * relevant language is not already {@link ensureLoaded loaded}.
 */
export function documentTreeSync(
  document: vscode.TextDocument,
  options: DocumentTreeOptions = {},
): Tree {
  // Initialize parser with the relevant language.
  const language = getLanguageSync(
    options.language ?? determineLanguageOrFail(document),
  );
  const parser = new TreeSitter();

  try {
    parser.setLanguage(language);

    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
      parser.setTimeoutMicros(options.timeoutMs * 1e3);
    }

    // Parse and return the tree.
    if (options.cache instanceof Cache) {
      const state = documentCache.get(document);

      if (state === undefined) {
        const tree = parser.parse(document.getText());
        documentCache.set(document, { tree: tree.copy(), dirtyTimestamp: 0 });
        return tree;
      } else if (state.dirtyTimestamp !== 0) {
        const tree = parser.parse(document.getText(), state.tree);
        state.tree.delete();
        state.tree = tree.copy();
        state.dirtyTimestamp = 0;
        return tree;
      } else {
        return state.tree.copy();
      }
    } else {
      return parser.parse(document.getText());
    }
  } finally {
    parser.delete();
  }
}

/**
 * Compiles the given string into a {@link Query} object which can be used to
 * perform queries on nodes of the given language.
 *
 * @see {@link https://tree-sitter.github.io/tree-sitter/using-parsers#query-syntax}
 */
export function query(
  language: HasLanguage,
): (strings: TemplateStringsArray, ...args: any) => Promise<Query>;
export function query(language: HasLanguage, source: string): Promise<Query>;

export function query(language: HasLanguage, source?: string) {
  if (source === undefined) {
    return (strings: TemplateStringsArray, ...args: any[]) =>
      query(language, String.raw(strings, ...args));
  }

  return ensureLoaded(language).then(() => querySync(language, source));
}

/**
 * Compiles the given string into a {@link Query} object which can be used to
 * perform queries on nodes of the given language, failing if it is not already
 * {@link ensureLoaded loaded}.
 */
export function querySync(
  language: HasLanguage,
): (strings: TemplateStringsArray, ...args: any) => Query;
export function querySync(
  language: HasLanguage,
  source: string,
): Query;

export function querySync(language: HasLanguage, source?: string) {
  if (source === undefined) {
    return (strings: TemplateStringsArray, ...args: any[]) =>
      querySync(language, String.raw(strings, ...args));
  }

  return getLanguageSync(determineLanguageOrFail(language)).query(source);
}

/**
 * Executes the specified function with the result of {@link documentTree()},
 * {@link Tree.delete() deleting} the tree after the end of the function.
 */
export const withDocumentTree = makeWith(documentTree) as {
  <T>(
    document: vscode.TextDocument,
    k: (tree: Tree) => T | PromiseLike<T>,
  ): Promise<T>;
  <T>(
    document: vscode.TextDocument,
    options: DocumentTreeOptions | undefined,
    k: (tree: Tree) => T | PromiseLike<T>,
  ): Promise<T>;
};

/**
 * Executes the specified function with the result of {@link documentTreeSync()},
 * {@link Tree.delete() deleting} the tree after the end of the function.
 */
export const withDocumentTreeSync = makeSyncWith(documentTreeSync) as {
  <T>(document: vscode.TextDocument, k: (tree: Tree) => T): T;
  <T>(
    document: vscode.TextDocument,
    options: DocumentTreeOptions | undefined,
    k: (tree: Tree) => T,
  ): T;
};

/**
 * Executes the specified function with the result of {@link query()},
 * {@link Query.delete() deleting} the query after the end of the function.
 */
export const withQuery = makeWith(query) as {
  <T>(
    language: HasLanguage,
    source: string,
    k: (query: Query) => T | PromiseLike<T>,
  ): Promise<T>;
};

/**
 * Executes the specified function with the result of {@link querySync()},
 * {@link Query.delete() deleting} the query after the end of the function.
 */
export const withQuerySync = makeSyncWith(querySync) as {
  <T>(language: HasLanguage, source: string, k: (query: Query) => T): T;
};

/**
 * Executes the specified function with the given arguments, calling
 * `arg.delete()` for each `arg` in `args` after the end of its execution.
 *
 * The function may return a `Promise`, in which case a promise will be
 * returned as well.
 */
export function using<T, Args extends { delete(): void }[]>(
  ...args: [...Args, (...args: Args) => T]
): T {
  const f = args.pop() as (...args: Args) => T;
  let result: T;

  try {
    result = f(...args as unknown as Args);
  } catch (e) {
    for (const arg of args as unknown as Args) {
      arg.delete();
    }

    throw e;
  }

  if (
    result == null ||
    typeof (result as unknown as PromiseLike<unknown>)["then"] !== "function"
  ) {
    for (const arg of args as unknown as Args) {
      arg.delete();
    }

    return result;
  }

  return (async () => {
    try {
      return await result;
    } finally {
      for (const arg of args as unknown as Args) {
        arg.delete();
      }
    }
  })() as T;
}

/**
 * A Tree Sitter point with UTF-16-based offsets.
 *
 * @see {@link TreeSitter.Point}
 */
export type Point = TreeSitter.Point;

/**
 * Converts a Tree Sitter {@link Point} to a {@link vscode.Position}.
 */
export function toPosition(point: Point): vscode.Position {
  return new vscode.Position(point.row, point.column);
}

/**
 * Converts a {@link vscode.Position} into a Tree Sitter {@link Point}.
 */
export function fromPosition(position: vscode.Position): Point {
  return { row: position.line, column: position.character };
}

/**
 * Returns the {@link vscode.Position} of a Tree Sitter syntax node.
 */
export function toRange(node: SyntaxNode): vscode.Range {
  const startPosition = toPosition(node.startPosition);

  if (node.startIndex === node.endIndex) {
    return new vscode.Range(startPosition, startPosition);
  }

  return new vscode.Range(startPosition, toPosition(node.endPosition));
}

/**
 * Returns the start and end Tree Sitter {@link Point} positions of a
 * {@link vscode.Range}.
 */
export function fromRange(
  range: vscode.Range,
): { startPosition: Point; endPosition: Point } {
  return {
    startPosition: fromPosition(range.start),
    endPosition: fromPosition(range.end),
  };
}

function resolveWasmFilePath(path: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionContext.extensionUri, "out", path);
}

function getLanguageSync(language: Language): TreeSitter.Language {
  const loadedLanguage = loadedLanguages[language];

  if (!(loadedLanguage instanceof TreeSitter.Language)) {
    throw new Error(`language "${language}" is not loaded`);
  }

  return loadedLanguage;
}

function makeWith<Args extends any[], R extends { delete(): void }>(
  f: (...args: Args) => Promise<R>,
): <T>(...args: [...Args, (value: R) => T | PromiseLike<T>]) => Promise<T> {
  return async function withDeleteObject(...args) {
    const k = args.pop() as (value: R) => PromiseLike<any>;
    const result = await f(...args as unknown as Args);

    try {
      return await k(result);
    } finally {
      result.delete();
    }
  };
}

function makeSyncWith<Args extends any[], R extends { delete(): void }>(
  f: (...args: Args) => R,
): <T>(...args: [...Args, (value: R) => T]) => T {
  return function withDeleteObject(...args) {
    const k = args.pop() as (value: R) => any;
    const result = f(...args as unknown as Args);

    try {
      return k(result);
    } finally {
      result.delete();
    }
  };
}
