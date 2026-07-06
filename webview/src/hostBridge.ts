// VS Code webview sandbox workarounds for browser APIs that Streamdown's
// copy/download controls rely on:
//
//  - navigator.clipboard.writeText / write: blocked or focus-gated in webviews.
//    → forward the text to the extension host (vscode.env.clipboard).
//  - <a download> with a blob: URL: navigation/download is blocked in webviews.
//    → intercept the click, read the blob back, and ask the host to open a
//      save dialog and write the file.
//
// Must be installed once at startup, before any UI renders.

import { getVsCodeApi } from "./vscode";

export function installHostBridge(): void {
  const vscode = getVsCodeApi();

  // --- Clipboard ---------------------------------------------------------
  const forwardToHost = (text: string) => {
    vscode.postMessage({ type: "clipboardWrite", value: text });
  };

  const nativeClipboard = navigator.clipboard;
  const clipboardOverride: Pick<Clipboard, "writeText"> & { write?: (items: ClipboardItem[]) => Promise<void> } = {
    async writeText(text: string) {
      try {
        await nativeClipboard?.writeText(text);
      } catch {
        // fall through to host
      }
      forwardToHost(text); // host write is authoritative; harmless if native worked
    },
    async write(items: ClipboardItem[]) {
      for (const item of items ?? []) {
        try {
          if (item.types.includes("text/plain")) {
            const blob = await item.getType("text/plain");
            forwardToHost(await blob.text());
            return;
          }
        } catch {
          continue;
        }
      }
    }
  };

  try {
    Object.defineProperty(navigator, "clipboard", { value: clipboardOverride, configurable: true });
  } catch {
    // Property not configurable in this runtime — copy buttons will use native.
  }

  // --- Downloads ---------------------------------------------------------
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a[download]") as HTMLAnchorElement | null;
      if (!anchor) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const href = anchor.href;
      const name = anchor.getAttribute("download") || "download.txt";

      void (async () => {
        try {
          let content = "";
          if (href.startsWith("blob:") || href.startsWith("data:")) {
            content = await (await fetch(href)).text();
          }
          vscode.postMessage({ type: "saveFile", value: { name, content } });
        } catch (error) {
          console.warn("download bridge failed", error);
        }
      })();
    },
    true
  );
}
