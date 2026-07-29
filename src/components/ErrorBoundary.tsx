import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught React error:");
    console.error("Error:", error);
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    console.error("Component stack:", errorInfo.componentStack);

    this.setState({ errorInfo });
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          padding: '20px',
          background: '#1a1a1a',
          color: '#e7e5e4',
          fontFamily: 'monospace',
          fontSize: '12px',
          overflow: 'auto',
          maxHeight: '100vh'
        }}>
          <h2 style={{ color: '#ef4444', marginBottom: '16px' }}>React Error Caught</h2>
          <div style={{ marginBottom: '12px' }}>
            <strong style={{ color: '#f97316' }}>Error:</strong>
            <pre style={{ margin: '8px 0', padding: '8px', background: '#2a2a2a', borderRadius: '4px' }}>
              {this.state.error?.message}
            </pre>
          </div>
          <div style={{ marginBottom: '12px' }}>
            <strong style={{ color: '#f97316' }}>Stack:</strong>
            <pre style={{ margin: '8px 0', padding: '8px', background: '#2a2a2a', borderRadius: '4px', maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {this.state.error?.stack}
            </pre>
          </div>
          {this.state.errorInfo?.componentStack && (
            <div>
              <strong style={{ color: '#f97316' }}>Component Stack:</strong>
              <pre style={{ margin: '8px 0', padding: '8px', background: '#2a2a2a', borderRadius: '4px', maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {this.state.errorInfo.componentStack}
              </pre>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
