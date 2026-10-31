import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

/**
 * A bug on one screen must not leave a blank window. Recording, jobs and data all live outside the UI,
 * so reloading the screen loses nothing.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { failed: boolean; lastKey: unknown }> {
  override state = { failed: false, lastKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { failed: boolean; lastKey: unknown }) {
    // Moving to another screen clears the error, so one bad screen does not block the others.
    if (props.resetKey !== state.lastKey) return { failed: false, lastKey: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen failed to render', error.message, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <CircleAlert size={32} aria-hidden style={{ color: 'var(--danger)' }} />
        <h2>This screen hit a problem</h2>
        <p className="muted">Your recordings are safe. Reloading usually fixes it.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
