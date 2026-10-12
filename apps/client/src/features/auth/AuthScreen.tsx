import type { AuthResponse } from '@bh/contracts';
import { DevLoginRequest, LoginRequest, RegisterRequest } from '@bh/contracts';
import { useMutation } from '@tanstack/react-query';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { api, queryClient } from '../../api/client';
import { describeError } from '../../api/errors';
import { useAuthConfig } from '../../api/queries';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { useAuthStore } from '../../store/auth';
import { Tabs } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Logo } from '../../ui/Logo';
import { ErrorState, SkeletonRows } from '../../ui/States';

const LandingWorld = lazy(() => import('../../world/LandingWorld'));

declare global {
  interface Window {
    /** Injected by the Steam desktop shell (Electron preload). */
    bharatHarvestDesktop?: {
      getSteamTicket?: () => Promise<string | null | undefined>;
    };
  }
}

function useSignIn<V>(fn: (v: V) => Promise<AuthResponse>) {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      queryClient.clear();
      setSession(res);
    },
  });
}

function FieldError({ text }: { text?: string | null }) {
  return text ? <div className="bh-error-text">{text}</div> : null;
}

function firstIssue(
  result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } },
  field: string,
) {
  if (result.success || !result.error) return null;
  return result.error.issues.find((i) => i.path[0] === field)?.message ?? null;
}

function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const m = useSignIn((v: LoginRequest) => api.login(v));
  const parsed = LoginRequest.safeParse({ username, password });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.success) m.mutate(parsed.data);
  };
  return (
    <form className="bh-stack" onSubmit={submit} data-testid="login-form" noValidate>
      <div className="bh-field">
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          className="bh-input"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid="login-username"
          aria-invalid={touched && !!firstIssue(parsed, 'username')}
        />
        {touched ? <FieldError text={firstIssue(parsed, 'username')} /> : null}
      </div>
      <div className="bh-field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          className="bh-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="login-password"
        />
      </div>
      {m.isError ? (
        <div className="bh-callout danger" role="alert">
          {describeError(m.error).message}
        </div>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        busy={m.isPending}
        data-testid="login-submit"
      >
        Sign in
      </Button>
    </form>
  );
}

function RegisterForm() {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const m = useSignIn((v: RegisterRequest) => api.register(v));
  const parsed = RegisterRequest.safeParse({ username, password, displayName });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.success) m.mutate(parsed.data);
  };
  return (
    <form className="bh-stack" onSubmit={submit} data-testid="register-form" noValidate>
      <div className="bh-field">
        <label htmlFor="reg-username">Username</label>
        <input
          id="reg-username"
          className="bh-input"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid="register-username"
        />
        {touched ? (
          <FieldError text={firstIssue(parsed, 'username')} />
        ) : (
          <div className="bh-hint">3–24 letters, digits or underscore.</div>
        )}
      </div>
      <div className="bh-field">
        <label htmlFor="reg-display">Display name</label>
        <input
          id="reg-display"
          className="bh-input"
          autoComplete="nickname"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          data-testid="register-display-name"
        />
        {touched ? <FieldError text={firstIssue(parsed, 'displayName')} /> : null}
      </div>
      <div className="bh-field">
        <label htmlFor="reg-password">Password</label>
        <input
          id="reg-password"
          className="bh-input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="register-password"
        />
        {touched ? (
          <FieldError text={firstIssue(parsed, 'password')} />
        ) : (
          <div className="bh-hint">At least 10 characters.</div>
        )}
      </div>
      {m.isError ? (
        <div className="bh-callout danger" role="alert">
          {describeError(m.error).message}
        </div>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        busy={m.isPending}
        data-testid="register-submit"
      >
        Create account
      </Button>
    </form>
  );
}

function DevLoginForm() {
  const [username, setUsername] = useState('');
  const m = useSignIn((v: DevLoginRequest) => api.devLogin(v));
  const parsed = DevLoginRequest.safeParse({ username });
  return (
    <form
      className="bh-stack"
      data-testid="dev-login-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.success) m.mutate(parsed.data);
      }}
    >
      <div className="bh-field">
        <label htmlFor="dev-username">Developer quick start</label>
        <div className="bh-row">
          <input
            id="dev-username"
            className="bh-input"
            placeholder="any_username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="dev-login-username"
          />
          <Button
            type="submit"
            disabled={!parsed.success}
            busy={m.isPending}
            data-testid="dev-login-submit"
          >
            Enter
          </Button>
        </div>
        <div className="bh-hint">Development builds only — no password.</div>
      </div>
      {m.isError ? (
        <div className="bh-callout danger" role="alert">
          {describeError(m.error).message}
        </div>
      ) : null}
    </form>
  );
}

function SteamButton() {
  const bridge = typeof window !== 'undefined' ? window.bharatHarvestDesktop : undefined;
  const available = typeof bridge?.getSteamTicket === 'function';
  const [error, setError] = useState<string | null>(null);
  const m = useSignIn((ticket: string) => api.steamLogin({ ticket }));
  const onClick = async () => {
    setError(null);
    try {
      const ticket = await bridge?.getSteamTicket?.();
      if (!ticket) {
        setError('Steam did not provide a session ticket. Is the Steam client running?');
        return;
      }
      m.mutate(ticket);
    } catch {
      setError('Could not talk to Steam. Restart the game from your Steam library.');
    }
  };
  return (
    <div className="bh-stack">
      <Button
        size="lg"
        block
        icon="steam"
        onClick={() => void onClick()}
        disabled={!available}
        busy={m.isPending}
        data-testid="steam-login"
      >
        Sign in with Steam
      </Button>
      {!available ? (
        <div className="bh-hint">Available when playing from the Steam desktop app.</div>
      ) : null}
      {error ? <div className="bh-error-text">{error}</div> : null}
      {m.isError ? <div className="bh-error-text">{describeError(m.error).message}</div> : null}
    </div>
  );
}

export function AuthScreen() {
  const config = useAuthConfig();
  const reason = useAuthStore((s) => s.signedOutReason);
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const cfg = config.data;
  return (
    <main className="bh-landing">
      <div className="bh-landing-fallback" />
      <div className="bh-landing-canvas" aria-hidden="true">
        <ErrorBoundary fallback={() => null}>
          <Suspense fallback={null}>
            <LandingWorld />
          </Suspense>
        </ErrorBoundary>
      </div>
      <div className="bh-landing-vignette" />
      <div className="bh-landing-content">
        <div className="bh-hero">
          <div className="bh-row" style={{ gap: 12 }}>
            <Logo size={44} />
            <span
              className="faint"
              style={{
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                fontSize: 12,
                fontWeight: 650,
              }}
            >
              Tamil Nadu · 32 districts
            </span>
          </div>
          <h1>
            Bharat <span>Harvest</span>
          </h1>
          <p className="tagline">
            Survey red-soil uplands and paddy flats, plant to the season, sell at the APMC mandi,
            and grow a farm company across a living, shared Tamil Nadu that keeps turning while you
            are away.
          </p>
          <section className="bh-auth-card bh-glass bh-scroll" aria-label="Sign in">
            {reason ? (
              <div className="bh-callout info" role="status">
                <Icon name="info" size={16} />
                <span>{reason}</span>
              </div>
            ) : null}
            {config.isPending ? <SkeletonRows rows={4} height={30} /> : null}
            {config.isError ? (
              <ErrorState error={config.error} onRetry={() => void config.refetch()} compact />
            ) : null}
            {cfg ? (
              <>
                {cfg.passwordAuth ? (
                  <>
                    <Tabs
                      label="Account"
                      value={tab}
                      onChange={setTab}
                      tabs={[
                        { id: 'login', label: 'Sign in', testId: 'auth-tab-login' },
                        { id: 'register', label: 'Create account', testId: 'auth-tab-register' },
                      ]}
                    />
                    {tab === 'login' ? <LoginForm /> : <RegisterForm />}
                  </>
                ) : null}
                {cfg.steamAuth ? (
                  <>
                    {cfg.passwordAuth ? <div className="bh-divider-text">or</div> : null}
                    <SteamButton />
                  </>
                ) : null}
                {cfg.devAuth ? (
                  <>
                    {cfg.passwordAuth || cfg.steamAuth ? (
                      <div className="bh-divider-text">developer</div>
                    ) : null}
                    <DevLoginForm />
                  </>
                ) : null}
                {!cfg.passwordAuth && !cfg.steamAuth && !cfg.devAuth ? (
                  <div className="bh-callout warning">
                    Sign-in is currently disabled on this server.
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
            A game simulation inspired by Indian agriculture — yields and prices are modelled, not
            agronomic advice.
          </p>
        </div>
      </div>
    </main>
  );
}
