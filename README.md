# `tree-sitter-api`

A VS Code extension that exposes the Tree Sitter API to other extensions.

It can:

1. Load the Tree Sitter WebAssembly module, as well as supported languages.
2. Dispose of trees and queries that are no longer in use.
3. Cache parsed trees.
4. Detect languages.

## WIP

This is work-in-progress intended for future use within
[Dance](https://github.com/71/dance). A few more polishing touches are needed
before it will be ready to publish on the extension store.

Among other things, the "raw" API of Tree Sitter is still leaked in a few places
(e.g. with the `SyntaxNode` API), and it has only been tested in a dev
environment (so prod environments should be tested, both in the browser and in
VS Code directly).

## Usage

See [`extension.test.ts`](src/test/suite/extension.test.ts) for an up-to-date
example.

```typescript
const TreeSitter = await vscode.extensions.getExtension<API>(
  "gregoire.tree-sitter-api",
).activate();

const tree = await TreeSitter.documentTree(document);
const query = await TreeSitter.query(document)`
  (macro_invocation) @macro
`;

const captures = query.captures(tree.rootNode);
const macroCapture = captures.find(({ name }) => name === "macro");

assert.ok(macroCapture);
assert.strictEqual(macroCapture.node.type, "macro_invocation");
assert.strictEqual(macroCapture.node.text, 'println!("bar")');
```
