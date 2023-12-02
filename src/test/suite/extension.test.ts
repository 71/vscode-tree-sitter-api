import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", function () {
  let document: vscode.TextDocument;
  let TreeSitter: import("../../extension").API;

  this.beforeAll(async () => {
    TreeSitter = (await vscode.extensions.getExtension<
      import("../../extension").API
    >("gregoire.tree-sitter")?.activate())!;
  });

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

  test("Text objects", async () => {
    await TreeSitter.withDocumentTree(document, async (tree) => {
      const query = await TreeSitter.textObjectQueryFor(document);

      assert.ok(query);

      const captures = query.captures(tree.rootNode);
      const functionAroundCapture = captures.find(({ name }) =>
        name === "function.around"
      );
      const functionInsideCapture = captures.find(({ name }) =>
        name === "function.inside"
      );

      assert.ok(functionAroundCapture);
      assert.strictEqual(
        functionAroundCapture.node.text,
        `pub fn foo() {
          println!("bar");
        }`.replace(/^ {8}/gm, ""),
      );

      assert.ok(functionInsideCapture);
      assert.strictEqual(
        functionInsideCapture.node.text,
        `{
          println!("bar");
        }`.replace(/^ {8}/gm, ""),
      );
    });
  });
});
