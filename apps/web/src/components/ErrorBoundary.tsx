import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary (the route path). */
  resetKey?: string;
}
interface S {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, S> {
  override state: S = { error: null };
  static getDerivedStateFromError(error: Error): S {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Route error', error, info.componentStack);
  }
  override componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="page narrow" role="alert">
          <h1>Something went wrong</h1>
          <p className="muted">This page hit an unexpected problem. Your account and funds are not affected.</p>
          <button type="button" className="btn primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
