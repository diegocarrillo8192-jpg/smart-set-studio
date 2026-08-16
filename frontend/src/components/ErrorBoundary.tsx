import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", fontSize: 13, color: "#f8fafc", background: "#0a0c12", minHeight: "100vh" }}>
          <h1 style={{ color: "#f87171", marginBottom: 12 }}>Error en la interfaz</h1>
          <pre style={{ whiteSpace: "pre-wrap", background: "#1b2336", padding: 12, borderRadius: 8 }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
            {"\n\n"}
            {this.state.info?.componentStack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
