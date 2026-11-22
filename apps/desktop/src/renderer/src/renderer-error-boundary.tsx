import { Component, type ReactNode } from 'react';
import { PageError, errorDigest } from '@oat/ui/components/page-error';

export class RendererErrorBoundary extends Component<
  { children: ReactNode; reload?(): void; compact?: boolean },
  { error: { digest?: string } | null }
> {
  override state = { error: null as { digest?: string } | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: { digest: errorDigest(error) } };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main
        className={
          this.props.compact
            ? 'flex min-h-0 flex-1 items-center justify-center'
            : 'flex min-h-0 flex-1 items-center justify-center p-6'
        }
        data-testid="renderer-error"
      >
        <PageError
          compact={this.props.compact}
          onRetry={() => this.setState({ error: null })}
          digest={this.state.error.digest}
          onReload={() => (this.props.reload ?? (() => window.location.reload()))()}
        >
          <p className="text-copy-14 text-gray-900">
            Any recording keeps running in the background. Reloading this window won’t stop it.
          </p>
        </PageError>
      </main>
    );
  }
}
