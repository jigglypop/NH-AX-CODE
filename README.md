# Clarus Code

Clarus Code is a Claude Code inspired VS Code extension with a sidebar coding chat, editor selection actions, and lightweight workspace context.

The extension host is TypeScript, and the sidebar Webview UI is React + Vite.

## Run locally

1. Run `npm install`.
2. Run `npm run compile`.
3. Press `F5` in VS Code and choose `Run Extension`.
4. Open the Clarus Code icon in the activity bar.

If the view says that no data provider is registered, make sure `package.json` contributes the chat view with `"type": "webview"`, then restart the Extension Development Host. You can also open `Output: Clarus Code` to confirm that the extension activated and registered `clarusCode.chat`.

## React hot reload

For Webview UI work:

1. Run `npm run dev:webview` in a terminal.
2. In VS Code, press `F5` and choose `Run Extension (React HMR)`.
3. Edit files under `webview/src`.

React Webview changes hot reload through Vite. Changes to `src/extension.ts` or `package.json` still require reloading the Extension Development Host.

## Project layout

- `src/extension.ts`: VS Code commands, model calls, workspace context, and file actions
- `webview/src/App.tsx`: React sidebar UI
- `webview/vite.config.ts`: Webview build config
- `media/favicon.png`: Activity bar icon generated from `favicon.ico`

## Settings

- `clarusCode.provider`: `openai`, `anthropic`, or `openai-compatible`
- `clarusCode.apiKey`: your provider API key
- `clarusCode.model`: model name
- `clarusCode.openAICompatibleBaseUrl`: base URL for local/OpenAI-compatible servers
- `clarusCode.requestHeaders`: optional extra headers for internal gateways
- `clarusCode.autoApplyFileActions`: apply generated file operations without confirmation

For local providers such as Ollama, set provider to `openai-compatible`, base URL to `http://localhost:11434/v1`, and model to a locally available model.

For an internal network model gateway, set provider to `openai-compatible`, point `clarusCode.openAICompatibleBaseUrl` at the internal `/v1` endpoint, and add any required gateway headers in `clarusCode.requestHeaders`.

## File actions

Clarus Code can apply model-generated workspace changes when the assistant returns a `clarus-actions` JSON block:

````
```clarus-actions
{
  "summary": "Update the README",
  "operations": [
    {
      "type": "replace",
      "path": "README.md",
      "content": "# New content\n"
    }
  ]
}
```
````

Supported operation types are `create`, `replace`, `replaceRange`, and `delete`. All paths must be relative and are constrained to the active workspace folder.

## Agent scopes

Use `@` mentions to grant focused context and edit scope:

- `@src` reads the `src` folder and allows scoped edits inside it.
- `@README.md` reads that file and allows scoped edits to that file.
- `@webview/src/App.tsx` targets a specific file.

Agent access modes:

- `@ scoped`: file actions are blocked unless they are inside an `@` mentioned file/folder.
- `Workspace`: file actions are allowed across the current workspace.
- `Full access`: the agent may plan across the whole workspace, but filesystem writes are still constrained to the VS Code workspace root.

Plan mode blocks generated file actions and asks the model to return an implementation plan instead.
