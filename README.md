# `tree-sitter`

A VS Code extension that exposes the Tree Sitter API to other extensions.

It can:

1. Load the Tree Sitter WebAssembly module, as well as supported languages.
2. Cache parsed trees.
3. Detect languages.

## WIP

This is work-in-progress intended for future use within
[Dance](https://github.com/71/dance). A few more polishing touches are needed
before it will be ready to publish on the extension store.

Among other things, the "raw" API of Tree Sitter is still leaked in a few places
(e.g. with the `SyntaxNode` API), and it has only been tested in a dev
environment (so prod environments should be tested, both in the browser and in
VS Code directly).

Most importantly, the API is very much subject to change.

## Usage

See [`extension.test.ts`](src/test/suite/extension.test.ts) for an up-to-date
example.

```typescript
const document = await vscode.workspace.openTextDocument({
  content: `
    pub fn foo() {
      println!("bar");
    }
  `,
  language: "rust",
});

const TreeSitter = await vscode.extensions.getExtension<API>(
  "gregoire.tree-sitter",
).activate()!;

await TreeSitter.withDocumentTree(document, async (tree) => {
  await TreeSitter.withQuery(
    document,
    `(macro_invocation) @macro`,
    (query) => {
      const captures = query.captures(tree.rootNode);
      const macroCapture = captures.find(({ name }) => name === "macro");

      assert.ok(macroCapture);
      assert.strictEqual(macroCapture.node.type, "macro_invocation");
      assert.strictEqual(macroCapture.node.text, 'println!("bar")');
    },
  );
});
```

Note:

1. Detection of the language of `document` was done automatically.
2. The Tree Sitter library and Rust parser were both loaded implicitly when
   calling `documentTree()`.
3. No object had to be manually deleted with `.delete()`.

## Scope inspection

This extension provides a command named "Inspect Scopes" which displays the
current scope in the status bar; hovering the scope will display all its
ancestors in a tooltip. This may help write commands that operate on the
returned tree or that perform queries.
