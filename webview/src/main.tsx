import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Clarus Code root element was not found.");
}

class RootErrorBoundary extends Component<{ children: ReactNode }, { message?: string; stack?: string }> {
  state: { message?: string; stack?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Clarus Code Webview render error", error, info);
  }

  render() {
    if (this.state.message) {
      return (
        <main className="boot-error">
          <strong>Clarus Code failed to render.</strong>
          <p>{this.state.message}</p>
          {this.state.stack ? <pre>{this.state.stack}</pre> : null}
        </main>
      );
    }

    return this.props.children;
  }
}

try {
  createRoot(root).render(
    <StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </StrictMode>
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = `<main class="boot-error"><strong>Clarus Code failed to start.</strong><p>${escapeHtml(message)}</p></main>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
