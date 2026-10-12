/**
 * Shared Playwright fixtures and helpers for Bharat Harvest E2E tests.
 * All tests run against a server with ENABLE_DEV_AUTH=true (the .env.example default).
 */
import { expect, test as base, type Page } from '@playwright/test';

export { expect };

/** API origin of the stack under test (isolated e2e server by default). */
export const API =
  process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 8090}`;

/** Unique-enough username for a test run. */
export function uid(prefix = 'e2e'): string {
  // Usernames are limited to 24 characters (letters, digits, underscore).
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  return `${prefix.slice(0, 10)}_${suffix}`;
}

/** Dev-login and wait for the game screen or company-creation screen. */
export async function devLogin(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('dev-login-username').fill(username);
  await page.getByTestId('dev-login-submit').click();
  // Either the company form or the game HUD appears.
  await expect(page.getByTestId('company-form').or(page.getByTestId('nav-map'))).toBeVisible({
    timeout: 10_000,
  });
}

/** Create a company if the company-form is visible, then wait for the game HUD. */
export async function ensureCompany(page: Page, name: string): Promise<void> {
  const form = page.getByTestId('company-form');
  if (await form.isVisible()) {
    await page.getByTestId('company-name-input').fill(name);
    await page.getByTestId('company-create-submit').click();
    await expect(page.getByTestId('nav-map')).toBeVisible({ timeout: 10_000 });
  }
}

/** Dismiss Muthu Thatha's story + guided tour so the plain next-step card shows. */
export async function skipTour(page: Page): Promise<void> {
  const story = page.getByTestId('tour-story-skip');
  const tour = page.getByTestId('tour-skip');
  await expect(story.or(tour)).toBeVisible({ timeout: 15_000 });
  if (await story.isVisible()) await story.click();
  await tour.click();
}

/** POST a command via the API directly (bypasses UI for setup). */
export async function apiPost(
  page: Page,
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const res = await page.request.post(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': uid('idem'),
    },
    data: body,
  });
  return res.json();
}

/** Extended test fixture that provides a logged-in page with a company. */
export const test = base.extend<{
  gamePage: Page;
  username: string;
  companyName: string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require object destructuring
  username: async ({}, use) => use(uid('player')),
  companyName: async ({ username }, use) => use(`Farm ${username.slice(-4)}`),
  gamePage: async ({ page, username, companyName }, use) => {
    await devLogin(page, username);
    await ensureCompany(page, companyName);
    await skipTour(page);
    await use(page);
  },
});

/** Open "Find land", pick the first area with land for sale, and open its cheapest holding. */
export async function openCheapestHoldingForSale(page: Page): Promise<void> {
  await page.getByTestId('nav-map').click();
  await expect(page.getByTestId('find-land')).toBeVisible();
  await page.getByTestId('find-sort').selectOption('cheapest');
  await page.getByTestId('find-land').locator('.tn-find-list button').first().click();
  await expect(page.getByTestId('segment-panel')).toBeVisible();
  const forSale = page
    .getByTestId('segment-panel')
    .getByRole('button', { name: 'View & buy' })
    .first();
  await expect(forSale).toBeVisible({ timeout: 10_000 });
  await forSale.click();
  await expect(page.getByTestId('parcel-inspector')).toBeVisible({ timeout: 10_000 });
}

/** The logged-in page's session token (persisted by the client as JSON). */
export async function sessionToken(page: Page): Promise<string> {
  await page.waitForLoadState('domcontentloaded');
  const handle = await page.waitForFunction(() => localStorage.getItem('bh.session.v1'), null, {
    timeout: 15_000,
  });
  const raw = (await handle.jsonValue()) as string | null;
  const token = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
  if (!token) throw new Error('no session token in localStorage');
  return token;
}

/** Dev-only: advance the world by `days` (requires ENABLE_DEV_ADMIN). */
export async function devAdvance(page: Page, days: number): Promise<void> {
  const res = await page.request.post(`${API}/api/v1/dev/advance`, {
    headers: {
      Authorization: `Bearer ${await sessionToken(page)}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': uid('adv'),
    },
    data: { days },
    timeout: 120_000,
  });
  if (!res.ok()) throw new Error(`dev advance failed: ${res.status()}`);
}

/**
 * Typed-enough API client for test setup. Commands get a fresh Idempotency-Key and are retried
 * once with the server's figure when a client-side price guard is stale (PRICE_CHANGED).
 */
export function apiFor(page: Page) {
  const base = `${API}/api/v1`;
  const headers = async () => ({
    Authorization: `Bearer ${await sessionToken(page)}`,
    'Content-Type': 'application/json',
  });
  const get = async <T>(path: string): Promise<T> => {
    const res = await page.request.get(`${base}${path}`, { headers: await headers() });
    if (!res.ok()) throw new Error(`GET ${path} → ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const post = async <T>(
    path: string,
    body: Record<string, unknown>,
    guardField?: string,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await page.request.post(`${base}${path}`, {
        headers: { ...(await headers()), 'Idempotency-Key': uid('cmd') },
        data: body,
        timeout: 120_000,
      });
      const json = (await res.json()) as {
        error?: { code: string; details?: { actual?: number } };
      };
      if (res.ok()) return json as T;
      if (
        guardField &&
        json.error?.code === 'PRICE_CHANGED' &&
        json.error.details?.actual !== undefined
      ) {
        body = { ...body, [guardField]: json.error.details.actual };
        continue;
      }
      throw new Error(`POST ${path} → ${res.status()} ${JSON.stringify(json)}`);
    }
    throw new Error(`POST ${path} failed after retry`);
  };
  return { get, post };
}

/** Plant a short crop on the starter plot via the API and advance until it is harvested. */
export async function growAndHarvest(page: Page): Promise<{ itemId: string; availableKg: number }> {
  const api = apiFor(page);
  const me = await api.get<{ company: { id: string } }>('/me');
  const map = await api.get<{
    parcels: { id: string; operatorCompanyId: string | null; crop: unknown }[];
  }>('/regions/tamil-nadu/map');
  const field = map.parcels.find((p) => p.operatorCompanyId === me.company.id && !p.crop);
  if (!field) throw new Error('no idle field');
  const suit = await api.get<{ results: { cropId: string; sowingOpen: boolean; score: number }[] }>(
    `/parcels/${field.id}/suitability`,
  );
  let crop = suit.results.find((r) => r.sowingOpen && r.cropId !== 'sugarcane' && r.score >= 40);
  for (let i = 0; !crop && i < 12; i++) {
    await devAdvance(page, 30);
    const again = await api.get<typeof suit>(`/parcels/${field.id}/suitability`);
    crop = again.results.find((r) => r.sowingOpen && r.cropId !== 'sugarcane' && r.score >= 40);
  }
  if (!crop) throw new Error('no sowable crop found');
  const detail = await api.get<{ parcel: { env: { waterAccess: string } } }>(
    `/parcels/${field.id}`,
  );
  await api.post(
    '/crop-plots',
    {
      parcelId: field.id,
      cropId: crop.cropId,
      irrigate: detail.parcel.env.waterAccess !== 'none',
      fertilize: true,
      expectedCostPaise: 1,
    },
    'expectedCostPaise',
  );
  // Jump straight to the ready day (one call), then harvest.
  const world = await api.get<{ gameDay: number }>('/world');
  const growing = await api.get<{
    plots: { id: string; status: string; readyDay: number | null }[];
  }>(`/companies/${me.company.id}/plots`);
  const plot = growing.plots.find((p) => p.status === 'growing' || p.status === 'ready');
  if (!plot) throw new Error('planted crop not found');
  if (plot.status !== 'ready') {
    await devAdvance(page, Math.max(1, (plot.readyDay ?? world.gameDay) - world.gameDay + 1));
  }
  const after = await api.get<typeof growing>(`/companies/${me.company.id}/plots`);
  const ready = after.plots.find((p) => p.id === plot.id);
  if (ready?.status !== 'ready') throw new Error(`crop not ready (status ${ready?.status})`);
  await api.post(`/crop-plots/${ready.id}/harvest`, {});
  const inv = await api.get<{ totals: { itemId: string; availableKg: number }[] }>(
    `/companies/${me.company.id}/inventory`,
  );
  const stock = inv.totals.find((t) => t.availableKg > 0);
  if (!stock) throw new Error('no harvest in storage');
  return stock;
}

/** Close the "While you were away" summary (or any modal) if it is open. */
export async function dismissModals(page: Page): Promise<void> {
  const modal = page.locator('[aria-modal="true"]');
  for (let i = 0; i < 3 && (await modal.count()) > 0 && (await modal.first().isVisible()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}
