export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    if (!window.acquireVsCodeApi) {
      api = {
        postMessage(message: unknown) {
          console.warn("VS Code API is not available.", message);
        },
        getState<T = unknown>() {
          return undefined as T | undefined;
        },
        setState() {}
      };
      return api;
    }
    api = window.acquireVsCodeApi();
  }
  return api;
}
