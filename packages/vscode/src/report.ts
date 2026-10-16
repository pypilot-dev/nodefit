/**
 * Read-only Markdown documents for the report and `check` results, shown in
 * VS Code's own Markdown preview. The server already renders Markdown (the
 * same text the CLI prints), so a virtual document gets links, tables and
 * theming for free without a webview and its HTML to keep safe.
 */

import * as vscode from "vscode";

export const SCHEME = "nodefit";

// Scoped names ("@img/sharp") must not turn into directories, and the ".md"
// gives the document the markdown language the preview needs.
function pathFor(name: string): string {
  return `/${name.replace(/[/\\]/g, "-")}.md`;
}

export class MarkdownDocuments implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? "# nodefit\n\nNothing to show yet.";
  }

  /** Sets a document's text and opens (or refreshes) its preview. */
  async show(name: string, markdown: string): Promise<void> {
    const uri = this.set(name, markdown);
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  }

  /** Updates a document's text; an open preview follows the change. */
  set(name: string, markdown: string): vscode.Uri {
    const path = pathFor(name);
    this.contents.set(path, markdown);
    const uri = vscode.Uri.from({ scheme: SCHEME, path });
    this.changed.fire(uri);
    return uri;
  }

  /** True when the named document has been shown and is still open. */
  isOpen(name: string): boolean {
    const path = pathFor(name);
    return vscode.workspace.textDocuments.some((d) => d.uri.scheme === SCHEME && d.uri.path === path);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
