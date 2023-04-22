import * as vscode from "vscode";
import TreeSitter from "web-tree-sitter";

import { SyntaxNode } from "web-tree-sitter";

export { type SyntaxNode, TreeSitter };

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
export type API = Omit<typeof import("./extension"), "activate" | "deactivate">;

/**
 * Activation function called by VS Code.
 */
export function activate(
  context: vscode.ExtensionContext,
): API {
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
  );

  // Public API:
  return Object.freeze({
    Cache,
    determineLanguage,
    determineLanguageOrFail,
    documentTree,
    documentTreeSync,
    ensureLoaded,
    Language,
    positionOf,
    query,
    querySync,
    rangeOf,
    TreeSitter,
  });
}

/**
 * De-activation function called by VS Code.
 */
export function deactivate(): void {
  // Clear cache.
  for (const key in languages) {
    delete languages[key as Language];
  }

  for (const { tree } of documentCache.values()) {
    tree.delete();
  }

  documentCache.clear();

  // Subscriptions will take care of event handlers registered above.
  //
  // Unfortunately, we can't dispose of the cache maintained within tree-sitter
  // itself.
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

const languages: {
  [language in Language]?: TreeSitter.Language | Promise<TreeSitter.Language>;
} = {};

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
  await TreeSitter.init({
    locateFile(path: string, prefix: string): string {
      if (path === "tree-sitter.wasm") {
        return resolveWasmFilePath(TreeSitterWasm);
      }

      // Fallback to default strategy.
      return prefix + path;
    },
  });

  if (language === undefined) {
    return;
  }

  const validLanguage = determineLanguageOrFail(language);

  await (languages[validLanguage] ??= TreeSitter.Language.load(
    resolveWasmFilePath(languageWasmMap[validLanguage]),
  ).then((l) => languages[validLanguage] = l));
}

/**
 * Type from which a {@link Language} can be determined.
 */
export type HasLanguage =
  | Language
  | string
  | vscode.Uri
  | vscode.TextDocument;

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

  /**
   * Clears all entries in the cache.
   */
  public clear(): void {}
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
}

/**
 * The object returned by {@link documentTree()} and {@link documentTreeSync()}.
 *
 * This tree does not need to be manually deleted.
 */
export interface DocumentTree {
  /**
   * The input {@link vscode.TextDocument TextDocument}.
   */
  readonly document: vscode.TextDocument;
  /**
   * The {@link Language} of the document.
   */
  readonly language: Language;
  /**
   * The {@link TreeSitter.SyntaxNode root node} of the document.
   */
  readonly rootNode: TreeSitter.SyntaxNode;

  /**
   * Returns a copy of the tree.
   */
  copy(): DocumentTree;

  /**
   * Performs the given edit on the tree, returning a new one.
   */
  edit(delta: TreeSitter.Edit): DocumentTree;

  /**
   * Returns a cursor over the tree. Note that the cursor must be disposed
   * manually using `delete()`.
   */
  walk(): TreeSitter.TreeCursor;

  getChangedRanges(other: DocumentTree): vscode.Range[];
  getEditedRange(other: DocumentTree): vscode.Range;
}

/**
 * Returns the document tree for the specified document,
 * {@link ensureLoaded loading} the necessary code first if necessary.
 */
export async function documentTree(
  document: vscode.TextDocument,
  options: DocumentTreeOptions = {},
): Promise<DocumentTree> {
  await ensureLoaded(document);

  return documentTreeSync(document, options);
}

const finalizationRegistry = new FinalizationRegistry<{ delete(): void }>((
  tree,
) => tree.delete());

const underlyingTrees = new WeakMap<DocumentTree, TreeSitter.Tree>();

/**
 * Returns the document tree for the specified document, failing if the
 * relevant language is not already {@link ensureLoaded loaded}.
 */
export function documentTreeSync(
  document: vscode.TextDocument,
  options: DocumentTreeOptions = {},
): DocumentTree {
  // Initialize parser with the relevant language.
  const parser = new TreeSitter();
  const languageToLoad = options.language ?? determineLanguageOrFail(document);
  const language = getLanguageSync(languageToLoad);

  if (!(language instanceof TreeSitter.Language)) {
    throw new Error(`language "${language}" is not loaded`);
  }

  parser.setLanguage(language);

  // Parse and return the tree.
  let tree: TreeSitter.Tree;

  if (options.cache instanceof Cache) {
    const state = documentCache.get(document);

    if (state === undefined) {
      tree = parser.parse(document.getText());
      documentCache.set(document, { tree: tree.copy(), dirtyTimestamp: 0 });
    } else if (state.dirtyTimestamp !== 0) {
      tree = parser.parse(document.getText(), state.tree);
      state.tree.delete();
      state.tree = tree.copy();
      state.dirtyTimestamp = 0;
    } else {
      tree = state.tree;
    }
  } else {
    tree = parser.parse(document.getText());
  }

  return treeToDocumentTree(tree, document, languageToLoad);
}

/**
 * A compiled query.
 */
export interface Query {
  readonly captureNames: readonly string[];

  matches(
    node: SyntaxNode,
    startPosition?: vscode.Position,
    endPosition?: vscode.Position,
  ): TreeSitter.QueryMatch[];
  captures(
    node: SyntaxNode,
    startPosition?: vscode.Position,
    endPosition?: vscode.Position,
  ): TreeSitter.QueryCapture[];
  predicatesForPattern(patternIndex: number): TreeSitter.PredicateResult[];
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

  return queryToQuery(
    getLanguageSync(determineLanguageOrFail(language)).query(source),
  );
}

/**
 * Returns the {@link vscode.Position} of a Tree Sitter syntax node.
 */
export function rangeOf(node: SyntaxNode): vscode.Range {
  const startPosition = positionOf(node.startPosition);

  if (node.startIndex === node.endIndex) {
    return new vscode.Range(startPosition, startPosition);
  }

  return new vscode.Range(startPosition, positionOf(node.endPosition));
}

/**
 * Converts a Tree Sitter point to a {@link vscode.Position}.
 */
export function positionOf(point: TreeSitter.Point): vscode.Position {
  return new vscode.Position(point.row, point.column);
}

function resolveWasmFilePath(path: string): string {
  if (DEV) {
    return vscode.Uri.joinPath(extensionContext.extensionUri, "out", path)
      .fsPath;
  } else {
    return extensionContext.asAbsolutePath(path);
  }
}

function getLanguageSync(language: Language): TreeSitter.Language {
  const loadedLanguage = languages[language];

  if (!(loadedLanguage instanceof TreeSitter.Language)) {
    throw new Error(`language "${language}" is not loaded`);
  }

  return loadedLanguage;
}

function queryToQuery(
  query: TreeSitter.Query,
): Query {
  const result = Object.freeze<Query>({
    captureNames: Object.freeze(query.captureNames),

    captures(node, startPosition, endPosition) {
      const start: TreeSitter.Point | undefined = startPosition === undefined
        ? undefined
        : { row: startPosition.line, column: startPosition.character };
      const end: TreeSitter.Point | undefined = endPosition === undefined
        ? undefined
        : { row: endPosition.line, column: endPosition.character };

      return query.captures(node, start, end);
    },
    matches(node, startPosition, endPosition) {
      const end: TreeSitter.Point | undefined = endPosition === undefined
        ? undefined
        : { row: endPosition.line, column: endPosition.character };
      const start: TreeSitter.Point | undefined = startPosition === undefined
        ? undefined
        : { row: startPosition.line, column: startPosition.character };

      return query.matches(node, start, end);
    },
    predicatesForPattern(patternIndex) {
      return query.predicatesForPattern(patternIndex);
    },
  });

  finalizationRegistry.register(result, query);

  return result;
}

function treeToDocumentTree(
  tree: TreeSitter.Tree,
  document: vscode.TextDocument,
  language: Language,
): DocumentTree {
  const documentTree = Object.freeze<DocumentTree>({
    document,
    language,

    get rootNode() {
      return tree.rootNode;
    },

    copy() {
      return treeToDocumentTree(tree.copy(), document, language);
    },
    edit(delta) {
      return treeToDocumentTree(tree.edit(delta), document, language);
    },
    walk() {
      return tree.walk();
    },

    // Note: Tree Sitter already performs the UTF-8 byte-indices -> UTF-16
    //   code-point-positions conversion internally, so we don't need any such
    //   conversion here.

    getChangedRanges(other) {
      const otherTree = underlyingTrees.get(other)!;
      const ranges = tree.getChangedRanges(otherTree);
      const importedRanges: vscode.Range[] = [];

      for (const range of ranges) {
        importedRanges.push(importRange(range));
      }

      return importedRanges;
    },
    getEditedRange(other) {
      const otherTree = underlyingTrees.get(other)!;
      const range = tree.getEditedRange(otherTree);

      return importRange(range);
    },
  });

  finalizationRegistry.register(documentTree, tree);
  underlyingTrees.set(documentTree, tree);

  return documentTree;
}

function importRange(range: TreeSitter.Range): vscode.Range {
  const startPosition = new vscode.Position(
    range.startPosition.row,
    range.startPosition.column,
  );

  if (range.startIndex === range.endIndex) {
    return new vscode.Range(startPosition, startPosition);
  }

  const endPosition = new vscode.Position(
    range.endPosition.row,
    range.endPosition.column,
  );

  return new vscode.Range(startPosition, endPosition);
}
