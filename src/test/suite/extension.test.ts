import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", function () {
  let document: vscode.TextDocument;

  this.beforeEach(async () => {
    document = await vscode.workspace.openTextDocument({
      content: `
        pub fn foo() {
          println!("bar");
        }
      `.replace(/^ {8}/gm, ""),
      language: "rust",
    });
  });

  this.afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("Simple test", async () => {
    const TreeSitter = (await vscode.extensions.getExtension<
      import("../../extension").API
    >("gregoire.tree-sitter")?.activate())!;

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
  });
});
