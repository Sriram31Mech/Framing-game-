import { Button } from '../ui/Button';
import { Logo } from '../ui/Logo';

export function Splash({
  message,
  error,
  onRetry,
  onSignOut,
}: {
  message: string;
  error?: string;
  onRetry?: () => void;
  onSignOut?: () => void;
}) {
  return (
    <div className="bh-splash" role="status" aria-live="polite">
      <div className="inner">
        <Logo size={56} />
        <div style={{ fontWeight: 650, color: 'var(--text)' }}>Bharat Harvest</div>
        {error ? (
          <>
            <div className="tone-danger">{error}</div>
            <div className="bh-row">
              {onRetry ? (
                <Button icon="refresh" onClick={onRetry}>
                  Try again
                </Button>
              ) : null}
              {onSignOut ? (
                <Button variant="ghost" onClick={onSignOut}>
                  Sign out
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <div className="bh-row">
            <span className="bh-spinner" aria-hidden="true" />
            <span>{message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
