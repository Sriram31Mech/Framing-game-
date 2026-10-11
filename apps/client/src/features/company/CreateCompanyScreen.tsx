import { CreateCompanyRequest, type MeResponse } from '@bh/contracts';
import { NO_STARTER_PLOT_BONUS_PAISE, STARTING_CASH_PAISE } from '@bh/domain';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { api, signOutLocally } from '../../api/client';
import { describeError } from '../../api/errors';
import { useCreateCompany } from '../../api/mutations';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { money } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Logo } from '../../ui/Logo';

const LandingWorld = lazy(() => import('../../world/LandingWorld'));

const SUGGESTIONS = ['Hemavati Agro', 'Malnad Fields Co', 'Kaveri Krishi', 'Red Earth Farms'];

export function CreateCompanyScreen({ me }: { me: MeResponse }) {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useCreateCompany();
  const parsed = CreateCompanyRequest.safeParse({ name });
  const issue = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Invalid name');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.success) create.mutate(parsed.data);
  };

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
            <Logo size={40} />
            <span className="muted">Namaskara, {me.account.displayName}</span>
          </div>
          <h1 style={{ fontSize: 36 }}>
            Found your <span>company</span>
          </h1>
          <form
            className="bh-auth-card bh-glass"
            onSubmit={submit}
            noValidate
            data-testid="company-form"
          >
            <div className="bh-field">
              <label htmlFor="company-name">Company name</label>
              <input
                id="company-name"
                className="bh-input"
                value={name}
                maxLength={40}
                autoFocus
                placeholder="e.g. Hemavati Agro"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={touched && !!issue}
                data-testid="company-name-input"
              />
              {touched && issue ? (
                <div className="bh-error-text">{issue}</div>
              ) : (
                <div className="bh-hint">
                  3–40 characters. Shown to other players and on the leaderboard.
                </div>
              )}
            </div>
            <div className="bh-row wrap" style={{ gap: 6 }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="bh-chip chip-neutral"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setName(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="bh-callout info">
              <Icon name="info" size={16} />
              <div>
                You start with <strong>{money(STARTING_CASH_PAISE)}</strong> and a small reserved
                starter plot (or {money(NO_STARTER_PLOT_BONUS_PAISE)} extra cash if none remain).
                The valley keeps simulating while you are offline — crops grow, taxes and loan
                instalments fall due.
              </div>
            </div>
            {create.isError ? (
              <div className="bh-callout danger" role="alert">
                {describeError(create.error).message}
              </div>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              busy={create.isPending}
              data-testid="company-create-submit"
            >
              Register company
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void api.logout().catch(() => undefined);
                signOutLocally();
              }}
            >
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
