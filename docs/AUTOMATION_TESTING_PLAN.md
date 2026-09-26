# Automation Testing Environment — Admin Dashboard

**Status:** Plan / Proposal
**Scope:** `frontends/admin-dashboard` (React 18 + Vite + Redux Toolkit) and its backend microservices.
**Goal:** Build an automated testing environment that verifies all dashboard features work as expected (end-to-end), and runs reliably in CI.

---

## 1. Executive Summary

The dashboard is a multi-tenant support portal UI that talks to ~13 backend microservices (tenant, session, ticket, queue, routing, automation, faq, bot, app, custom-fields, tag, websocket, sdk-gateway, etc.). It has **no frontend tests today**. Backend services have partial unit tests (Jest / `node:test`) but no consistent integration/E2E layer.

We will introduce a **testing pyramid** that fits the existing stack:

| Layer | Tool | Scope | Runs |
|-------|------|-------|------|
| Unit / Component | **Vitest + React Testing Library + MSW** | Hooks, Redux slices, services, components | Every PR (fast, no backend) |
| Integration (frontend) | **Vitest + MSW** (route-level) | Page rendering, forms, API contract via mocks | Every PR |
| Backend integration | **Jest / Supertest + Testcontainers** | Service endpoints against real Postgres/Redis/Kafka | Every PR (per service) |
| End-to-End (E2E) | **Playwright** | Real browser → real backend stack (Docker Compose) | Merge to main / nightly |
| API contract | **Pact or OpenAPI (schemathesis)** | Frontend ↔ service contract drift | Nightly |
| Visual regression | **Playwright screenshots** | Key screens layout | Nightly |

**Why these tools:**
- **Vitest** is a drop-in for the existing **Vite** config (same `vite.config.ts`, aliases, esbuild) — zero extra build config, fast in CI.
- **React Testing Library** matches the component-based (atoms/molecules/organisms) structure.
- **MSW** intercepts at the network layer, so the same axios `apiClient`/`authService` code is exercised without hitting real services.
- **Playwright** covers the real full-stack flows (auth/cookies, WebSocket, multi-service) that unit tests cannot.
- Reuse the repo's existing **Docker Compose** stack (`infra/docker-compose.yml`) as the E2E environment to avoid drift.

---

## 2. Current State Analysis

### 2.1 Frontend (admin-dashboard)
- **Stack:** React 18, TypeScript, Vite 5, React Router 6, Redux Toolkit 2 (`auth`, `session` slices), React Query v3 (server state), react-hook-form + yup, Tailwind, TipTap editors, reactflow (automation), recharts (analytics).
- **Auth model:** JWT in cookies (`accessToken`, `refreshToken`) + `localStorage.user`; `authService` handles login, SSO, refresh, logout. `ProtectedRoute` gates the dashboard. Session warning/heartbeat via `SessionProvider`.
- **API layer:** each feature has a `services/*.ts` module (≈40 services) built on `axios` with `getServiceUrl()` resolving per-service base URLs from `VITE_*_SERVICE_URL`.
- **Pages/features (routes in `App.tsx`):**
  - Public: `/login`, `/register`, `/forgot-password`, `/invitation/:token`, `/faq`, `/helpcenter/:slug`
  - Dashboard (protected): Real-Time Operations (Dashboard), Tickets (with smart views), Team, Roles & Permissions, FAQ, Bots, Apps + App Platform Settings, Analytics, Billing, Profile
  - Settings: Queues, Automation Rules, Routing, Advanced Features/Integrations, Custom Fields, Tags, Quick Replies, Status Definitions, SSO, AI Agent, Announcements, Help Center (+ HC Announcements)
- **Helpers/hooks to unit-test:** `usePermissions`, `useSession`, `useApp`, `useDebouncedValue`, `useBreadcrumbs`, `useMediaQuery`, `useOutsideClick`, `useStatusColors`, `useThemeColors`, `useNavigation`, `useElementWidth`.
- **Existing tests:** **none** (no vitest/jest/RTL/playwright/cypress configured; `package.json` has `typecheck`/`lint` only).

### 2.2 Backend services
- 27 service folders; test tooling is inconsistent: Jest (`ts-jest`) in most, `node --test` in `integration-service`, `webhook-service`, `ai-agent-service`. Example existing tests: `ticket-service/tests/smartViewFilters.test.ts`, `email-ticketing-service/src/__tests__/*`, `webhook-service/src/*.test.ts`, `integration-service/src/*.test.ts`.
- Infra via Docker Compose: **Postgres** (`:15432`), **PgBouncer** (`:6432`), **Redis** (`:6380`), **Kafka** (`:19092`), **Consul** (`:8500`).
- Service ports (from `infra/port-registry.json`): tenant 4005, ticket 4006, app 4007, custom-fields 4008, automation 4010, file-storage 4011, queue 4013, routing 4014, session 4015, tag 4016, websocket-gateway 4017, faq 4018, sdk-gateway 5003, realtime-messaging 5004, sdk-analytics 5005.
- Flyway migrations under `database/migrations` seed the schema.

### 2.3 CI/CD
- Jenkins (`Jenkinsfile`, `Jenkinsfile.consul`, `Jenkinsfile.docker-agents`) builds/deploys to AWS (ECR + EC2). There is currently **no automated test gate** before build/deploy. `root package.json` already exposes `npm test --workspaces`, which is the natural hook.

---

## 3. Testing Strategy (what "all features working" means)

We define a **feature coverage matrix** and require each feature to have:
1. A **unit/component** test (rendering + logic).
2. An **integration** test (service ↔ mocked API contracts) OR backend integration test.
3. An **E2E happy path** + at least one **negative/edge** path.

### 3.1 Critical user journeys (E2E, must-pass)
1. **Auth:** login (password) → dashboard loads → session refresh → logout. Plus SSO/callback and invitation signup.
2. **Tickets core:** list tickets, open ticket detail, reply, internal note, change status/priority, assign, add tags/custom fields, attach file.
3. **Smart views:** create/edit/apply AND/OR filter views, count updates in real time.
4. **Queues & Routing:** create queue, configure routing rule, verify ticket assignment.
5. **Automation:** create rule → trigger on ticket event → verify action executed.
6. **Team & Roles:** invite user (invitation token flow), assign role, permission-gated UI visibility.
7. **FAQ / Help Center:** CRUD FAQ, publish, public `/faq` and `/helpcenter/:slug` render.
8. **Bots / AI Agent:** create bot, configure AI agent settings, verify save/load.
9. **Apps / Announcements / Tags / Custom Fields / Statuses / Quick Replies:** CRUD round-trips.
10. **Analytics & Billing:** dashboards render with data, billing portal redirects.

### 3.2 Permission matrix testing
Because navigation and pages are permission-driven (`usePermissions`, `NAVIGATION_CONFIG.permission`), we test with **three roles** (admin, supervisor/agent, limited) and assert visible nav items, allowed routes, and blocked actions.

### 3.3 Multi-tenant testing
Every request carries tenant/domain context (subdomain + `domainId`). We seed **two tenants** and assert data isolation (tenant A never sees tenant B data).

---

## 4. Test Environment Architecture

### 4.1 Layer diagram

```
┌──────────────────────────────────────────────────────────────┐
│  Developer machine / CI runner                                 │
│                                                                │
│  ┌──────────────────────┐   ┌──────────────────────────────┐  │
│  │ Vitest (component)   │   │ Playwright (E2E)             │  │
│  │ + RTL + MSW (mocked) │   │ Chromium / Firefox / WebKit  │  │
│  └──────────────────────┘   └──────────────┬───────────────┘  │
│                                             │ real HTTP/WS     │
│                                             ▼                  │
│                          ┌──────────────────────────────────┐  │
│                          │ Docker Compose "test" profile     │  │
│                          │ nginx → admin-dashboard (vite prev)│ │
│                          │ session,ticket,tenant,queue,...    │ │
│                          │ postgres, redis, kafka, consul     │ │
│                          └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Two environments

| Env | Purpose | Backend | Speed | Used by |
|-----|---------|---------|-------|---------|
| **isolated (mocked)** | Component + integration tests | MSW mocks all HTTP/WS | seconds | PR pipeline |
| **full-stack (compose)** | E2E + contract tests | Real Docker Compose services + DB seed | minutes | main / nightly |

### 4.3 Directory layout (new)

```
frontends/admin-dashboard/
  vitest.config.ts            # extends vite.config.ts, adds test env
  src/test/
    setup.ts                  # jest-dom, MSW server lifecycle, cleanup
    msw/
      handlers.ts             # default happy-path handlers (per service)
      server.ts               # setupServer(...handlers)
      fixtures/               # tenant, users, tickets, queues, faqs...
    utils/
      renderWithProviders.tsx # RTL wrapper: Redux store, QueryClient, Router, TooltipProvider
      store.ts                # preloaded test store
      auth.ts                 # helper to seed cookies/localStorage
  src/**/__tests__/           # co-located unit/component tests
  src/**/**.test.tsx

e2e/                          # Playwright (repo root or admin-dashboard/e2e)
  playwright.config.ts
  fixtures/
    auth.setup.ts             # storageState login for each role
  specs/
    auth.spec.ts
    tickets.spec.ts
    smart-views.spec.ts
    queues-routing.spec.ts
    automation.spec.ts
    team-roles.spec.ts
    faq-helpcenter.spec.ts
    settings.spec.ts
    permissions.spec.ts
    multi-tenant.spec.ts
  seed/
    seed-test-data.ts         # creates tenants, users, queues, tickets via API

infra/
  docker-compose.test.yml     # test overrides: deterministic ports, seed, no volumes
```

---

## 5. Frontend Unit & Component Testing (Vitest + RTL + MSW)

### 5.1 Install

```bash
cd frontends/admin-dashboard
npm i -D vitest @vitest/coverage-v8 @vitest/ui jsdom \
        @testing-library/react @testing-library/jest-dom \
        @testing-library/user-event msw
```

### 5.2 `vitest.config.ts`

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["node_modules", "dist", "e2e/**"],
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.d.ts", "src/test/**", "src/ui/**"],
        thresholds: { lines: 60, functions: 60, branches: 50, statements: 60 },
      },
    },
  })
);
```

### 5.3 `src/test/setup.ts`

```ts
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

// jsdom gaps used by the app
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false, media: query, addEventListener: vi.fn(),
    removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
class RO { observe() {} unobserve() {} disconnect() {} }
// @ts-expect-error - jsdom
global.ResizeObserver = RO;
```

### 5.4 `renderWithProviders` helper

Wraps components in the same providers as `App.tsx`: Redux `Provider`, `QueryClientProvider` (retry off), `MemoryRouter`, `TooltipProvider`, `SessionProvider`.

```tsx
export function renderWithProviders(ui, {
  route = "/dashboard",
  preloadedAuth,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
} = {}) {
  const store = makeTestStore(preloadedAuth);
  return {
    store,
    ...render(
      <Provider store={store}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>
      </Provider>
    ),
  };
}
```

### 5.5 What to unit-test (concrete list)

**Redux slices** (`src/store/slices/`)
- `authSlice`: login success/failure thunks (`createAsyncThunk`), logout clears state, permission derivation, loading/error flags.
- `sessionSlice`: session config set, idle/expiry transitions.

**Hooks**
- `usePermissions`: given `user.permissions`, asserts `hasPermission(resource, action)` and role-based booleans. Table-driven cases crossing admin/agent/limited.
- `useSession`: heartbeat/refresh scheduling with fake timers.
- `useDebouncedValue`: fake timers.
- `useNavigation`, `useBreadcrumbs`: given route + permissions, returns expected nav tree/labels.
- `useApp`, `useMediaQuery`, `useOutsideClick`, `useStatusColors`, `useThemeColors`.

**Services** (with MSW)
- `authService`: `login`, `exchangeSsoCode`, `refreshAccessToken` (401 → refresh → retry), `clearAuthTokens`, `isAuthenticated`.
- `apiClient`: attaches `Authorization` from cookie; 401 removes tokens + redirects to `/login`.
- Each feature service CRUD: parse success envelope `{ success, data }`, propagate `{ success:false, error }`, pagination params.

**Components**
- `ProtectedRoute`: redirects when unauthenticated; renders children when authenticated; loading state.
- `Header`, `Sidebar`, `SidebarUserProfile`, `UserProfileMenu`: render with user, permission-gated items.
- `SessionWarning` / `SessionWarningBanner`: show at threshold, action buttons call expected handlers.
- Forms: Login, Registration, InvitationSignup, ForgotPassword (validation via yup, submit calls service).
- Complex pages (smoke + key interactions), using MSW fixtures:
  - `Tickets` (list render, filter, open detail modal)
  - `Team`, `Roles` (role list, permission toggles)
  - `QueueManagement`, `RoutingConfiguration`, `AutomationRules` (reactflow node add)
  - `FAQ`, `TagsManagement`, `EnhancedCustomFields`, `StatusDefinitions`, `QuickReplies`
  - `Analytics` (recharts render without crash), `BillingPortal`

### 5.6 MSW handlers — conventions

Handlers keyed by the service base URL patterns from `getServiceUrl` and the endpoint shapes observed in `services/*.ts`, e.g.:
- `POST */api/sessions/login` → `{ success, data: { user, tokens, sessionConfig } }`
- `GET */api/sessions/me`
- `POST */api/sessions/refresh`
- `GET/POST/PUT/DELETE` for tickets, queues, routing, automation, faq, tags, custom-fields, statuses, quick-replies, team, roles, apps, announcements, sso, ai-agent, helpcenter, analytics, billing.

Provide **fixtures** and helper factories (`makeUser`, `makeTicket`, `makeQueue`) so tests read clearly.

---

## 6. End-to-End Testing (Playwright)

### 6.1 Install

```bash
npm i -D @playwright/test
npx playwright install --with-deps
```

### 6.2 `playwright.config.ts` (repo root `e2e/`)

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,          // stateful backend; parallelize by project/worker carefully
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html"], ["junit", { outputFile: "results.xml" }], ["list"]],
  globalSetup: "./seed/global-setup.ts",   // waits for stack + seeds data
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    storageState: "fixtures/.auth/admin.json",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
    { name: "firefox",  use: { ...devices["Desktop Firefox"] }, dependencies: ["setup"] },
  ],
});
```

### 6.3 Auth fixtures (reuse real login to avoid token drift)

`fixtures/auth.setup.ts` logs in once per role and saves `storageState` (cookies + localStorage), so specs start authenticated:

```ts
import { test as setup, expect } from "@playwright/test";

const roles = ["admin", "agent", "limited"] as const;
for (const role of roles) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(process.env[`E2E_${role.toUpperCase()}_EMAIL`]!);
    await page.getByLabel("Password").fill(process.env[`E2E_${role.toUpperCase()}_PASSWORD`]!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.context().storageState({ path: `fixtures/.auth/${role}.json` });
  });
}
```

### 6.4 Backend stack for E2E

Use the existing compose stack with a test override:

```bash
# infra/docker-compose.test.yml adds: fixed DB seed, exposed ports, no named volumes
docker compose -f infra/docker-compose.yml -f infra/docker-compose.test.yml up -d
npm run db:migrate          # Flyway
npx tsx e2e/seed/seed-test-data.ts   # tenants, users, queues, tickets, faqs
npm run dev --workspace=frontends/admin-dashboard   # or serve built dist
npx playwright test
```

`global-setup.ts` should poll `/health` on each service (4005, 4006, 4007, 4013, 4014, 4015, 4016, 4018, 4010, 4017) and the dashboard URL before starting tests.

### 6.5 E2E specs breakdown

| Spec | Key assertions |
|------|----------------|
| `auth.spec.ts` | Valid login → dashboard; invalid login → error toast; logout clears cookies → redirect `/login`; expired access token auto-refresh; invitation signup via `/invitation/:token`; forgot-password UX |
| `tickets.spec.ts` | List loads; open detail; send public reply (appears); add internal note (visible only internally); change status/priority; assign agent; add tags; add custom field value; upload attachment; bulk actions modal |
| `smart-views.spec.ts` | Build AND/OR nested filter; save view; apply; correct tickets; count badge; real-time count update after creating a matching ticket (WebSocket) |
| `queues-routing.spec.ts` | Create queue; create routing rule; create ticket → routed to queue; working-hours/skills config persists |
| `automation.spec.ts` | Create automation rule (trigger + action) via reactflow; trigger event; verify action side-effects (e.g., status change/tag add) |
| `team-roles.spec.ts` | Invite user; invitation accepted; role assigned; permission change reflected in nav/actions |
| `faq-helpcenter.spec.ts` | FAQ CRUD; publish; public `/faq` renders; `/helpcenter/:slug` public render; HC announcements |
| `settings.spec.ts` | Tags, Custom Fields, Statuses, Quick Replies, Apps/Platform Settings, Announcements, SSO, AI Agent, Advanced Features — CRUD round-trips + reload persistence |
| `permissions.spec.ts` | For each role, assert nav items visible/hidden and forbidden routes redirect; forbidden API calls blocked |
| `multi-tenant.spec.ts` | Tenant A cannot read/modify tenant B resources (404/403); subdomain routing resolves correct tenant |
| `analytics-billing.spec.ts` | Analytics charts render; Billing portal link/redirect works |

### 6.6 E2E reliability rules
- **Deterministic data:** seed via API with stable IDs/prefixes (`e2e-`), clean up in `global-teardown`.
- **Prefer role/text selectors**; add `data-testid` only where semantics are ambiguous (add them to components deliberately).
- **No arbitrary sleeps** — use Playwright auto-waiting + `expect.poll` for real-time/WebSocket assertions.
- **Isolate:** each spec owns its data; run E2E serially (workers=1) against a single stack, or shard by tenant.
- **Mock third parties only:** email (Mailgun), S3, FCM push — stub at the service boundary via env flags.

---

## 7. Backend Integration Testing

### 7.1 Standardize the tooling
Pick **Jest + Supertest** as the default for HTTP services (already used widely), keep `node:test` where it exists, and add a shared test bootstrap in `services/shared`.

### 7.2 Service integration harness
For each service, spin up real dependencies with **Testcontainers** (Postgres, Redis) or reuse the compose stack:

```ts
// services/ticket-service/tests/integration/health.test.ts
import request from "supertest";
import { app } from "../../src/app";

describe("ticket-service integration", () => {
  it("GET /health is ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated ticket list", async () => {
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(401);
  });
});
```

### 7.3 Cross-service flows (contract-critical)
Cover the chains the dashboard depends on:
- **Auth chain:** session-service issues token → ticket-service validates via shared JWT secret.
- **Ticket → automation:** ticket created event → Kafka → automation-service executes rule → status/tag updated.
- **Ticket → routing:** ticket created → routing-service matches rule → queue assignment → queue-service counters.
- **Ticket → websocket:** ticket event → websocket-gateway → client receives frame.
- **File flow:** file-storage-service upload → signed URL → ticket-service attachment metadata.

### 7.4 API contract tests
- Generate an **OpenAPI spec** per service (or capture from running compose) and validate responses with **schemathesis**/Pact.
- Assert the **response envelope** `{ success: boolean, data?: T, error?: string }` that the frontend relies on (see `authService`).
- Fail CI when a service changes a field the frontend consumes (schema diff gate).

### 7.5 Load / stress (optional, scheduled)
- **k6** or **Artillery** against compose for: ticket list with complex smart-view filters, message throughput, WebSocket fan-out. Validate SLA (e.g., p95 < 2s) and the automation scaling flags.

---

## 8. CI/CD Integration (Jenkins)

Add a **quality gate** before build/deploy in `Jenkinsfile`:

```
Stage: Checkout
Stage: Install (npm ci --workspaces)
Stage: Lint + Typecheck        -> npm run lint:admin-dashboard && npm run typecheck:admin-dashboard
Stage: Unit/Component tests    -> npm run test:unit --workspace=frontends/admin-dashboard (vitest run --coverage)
Stage: Backend tests           -> npm test --workspaces (services)
Stage: Bring up E2E stack      -> docker compose -f infra/docker-compose.yml -f infra/docker-compose.test.yml up -d
Stage: Migrate + Seed          -> npm run db:migrate && tsx e2e/seed/seed-test-data.ts
Stage: E2E (Playwright)        -> npx playwright test
Stage: Publish artifacts       -> playwright-report/, coverage/lcov.info, junit results.xml
Stage: Build & Push (ECR)      -> only if all above pass
Stage: Deploy (EC2)            -> only if build passes
```

Rules:
- **PR pipeline:** Lint + Typecheck + Unit/Component tests (fast, no stack) — must be green to merge.
- **Main/nightly pipeline:** full compose E2E + contract + visual regression.
- **Gate:** build/deploy stages declare `when { expression { currentBuild.result == 'SUCCESS' } }`.
- Store Playwright `trace.zip`, videos, and HTML report as Jenkins artifacts for triage.

### 8.1 npm scripts to add

`frontends/admin-dashboard/package.json`:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```
Root `package.json`:
```json
{
  "scripts": {
    "test:e2e": "playwright test --config=e2e/playwright.config.ts",
    "test:e2e:ui": "playwright test --ui --config=e2e/playwright.config.ts",
    "test:e2e:stack": "docker compose -f infra/docker-compose.yml -f infra/docker-compose.test.yml up -d"
  }
}
```
> Note: root already has `"test": "npm run test --workspaces"`, so wiring `test` in the workspace makes `npm test` include the frontend automatically.

---

## 9. Implementation Roadmap

### Phase 0 — Foundations (week 1)
- [ ] Add `vitest.config.ts`, `src/test/setup.ts`, MSW `server.ts`/`handlers.ts`, `renderWithProviders`.
- [ ] Add npm scripts + `@vitest/coverage-v8`.
- [ ] Add `.github`/Jenkins **PR job** running lint + typecheck + `vitest run`.
- [ ] Add `data-testid` conventions doc + a few stable test ids on high-traffic elements.

### Phase 1 — Unit/component coverage of critical logic (weeks 2–3)
- [ ] `authSlice`, `sessionSlice`, `usePermissions`, `useSession`, `apiClient`, `authService`.
- [ ] `ProtectedRoute`, `Header`, `SidebarUserProfile`, `UserProfileMenu`, `SessionWarning`.
- [ ] Auth forms (Login, Registration, InvitationSignup, ForgotPassword).
- [ ] Target: **≥ 60% lines** on `src/store`, `src/hooks`, `src/services`.

### Phase 2 — Component/integration for feature pages (weeks 3–5)
- [ ] Tickets (+ modals), Team, Roles, FAQ, Tags, Custom Fields, Statuses, Quick Replies.
- [ ] QueueManagement, RoutingConfiguration, AutomationRules, Bots, AI Agent.
- [ ] Apps/Platform Settings, Announcements, SSO, Help Center, Analytics, Billing, Profile.
- [ ] Each page: happy render + one action + one error/empty state (MSW-driven).

### Phase 3 — E2E environment + critical journeys (weeks 5–7)
- [ ] `infra/docker-compose.test.yml`, `seed-test-data.ts`, `global-setup/teardown`.
- [ ] Playwright config + auth storageState fixtures (admin/agent/limited).
- [ ] Specs: `auth`, `tickets`, `smart-views`, `queues-routing`, `automation`.
- [ ] Wire E2E job into the main pipeline (non-blocking first, then blocking).

### Phase 4 — Remaining journeys + non-functional (weeks 7–9)
- [ ] Specs: `team-roles`, `faq-helpcenter`, `settings`, `permissions`, `multi-tenant`, `analytics-billing`.
- [ ] API contract checks (schemathesis/Pact) + response-envelope guard.
- [ ] Visual regression snapshots for key screens.
- [ ] Optional load tests (k6) for smart views, messaging, WebSocket.

### Phase 5 — Hardening & maintenance (ongoing)
- [ ] Flaky-test quarantine + retries policy; keep suite runtime < 15 min.
- [ ] Coverage thresholds enforced in CI; PRs fail on regression.
- [ ] Nightly full run + Slack/email notification with report links.
- [ ] Add tests alongside every new feature (definition of done).

---

## 10. Success Metrics

| Metric | Target |
|--------|--------|
| Unit/component coverage (store/hooks/services) | ≥ 60% lines |
| Feature coverage (matrix) | 100% of pages have ≥1 component test |
| E2E critical journeys | 100% pass on main |
| E2E suite runtime | < 15 min on CI runner |
| Flake rate | < 2% of runs |
| Regressions caught pre-merge | Increasing trend; zero P1 escapes with a test |

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Multi-service stack heavy/slow in CI | Use MSW for PR tests; run compose E2E only on main/nightly; cache Docker layers |
| Auth/cookie + WebSocket flakiness in E2E | Use real login for `storageState`; `expect.poll` for WS assertions; retries on CI |
| Inconsistent backend test tooling | Standardize on Jest+Supertest (keep `node:test` where present); shared bootstrap |
| Test data pollution / ordering | Deterministic `e2e-` prefix, per-spec data ownership, teardown reset |
| Missing stable selectors | Establish `data-testid` convention in Phase 0; prefer role/text first |
| Env config drift (many `VITE_*_SERVICE_URL`) | Single `.env.test` for compose + Playwright; document in `docs/ENVIRONMENT_CONFIGURATION.md` |
| Coverage vanity | Focus thresholds on store/hooks/services, not `ui/**` primitives |

---

## 12. Appendix

### 12.1 Full feature → test map

| Feature (route) | Component test | Integration/E2E |
|-----------------|----------------|-----------------|
| Login `/login` | ✅ form + validation | ✅ E2E auth |
| Registration `/register` | ✅ | ✅ (tenant creation) |
| Invitation `/invitation/:token` | ✅ | ✅ E2E team-roles |
| ForgotPassword `/forgot-password` | ✅ | ✅ UX only |
| Dashboard `/dashboard` | ✅ | ✅ E2E after login |
| Tickets `/dashboard/tickets*` | ✅ | ✅ E2E tickets + smart views |
| Team `/dashboard/team` | ✅ | ✅ E2E team-roles |
| Roles `/dashboard/roles` | ✅ | ✅ E2E permissions |
| FAQ `/dashboard/faq` + public `/faq` | ✅ | ✅ E2E faq-helpcenter |
| Bots `/dashboard/bots/:botId?` | ✅ | ✅ E2E settings |
| Apps `/dashboard/apps`, `/apps/settings/:publishId` | ✅ | ✅ E2E settings |
| Analytics `/dashboard/analytics` | ✅ | ✅ E2E analytics |
| Billing `/dashboard/billing` | ✅ | ✅ redirect check |
| Queues `/dashboard/settings/queues` | ✅ | ✅ E2E queues-routing |
| Automation `/dashboard/settings/automation` | ✅ | ✅ E2E automation |
| Routing `/dashboard/settings/routing` | ✅ | ✅ E2E queues-routing |
| Advanced/Integrations `/dashboard/settings/advanced` | ✅ | ✅ E2E settings |
| Custom Fields `/dashboard/settings/custom-fields` | ✅ | ✅ E2E settings |
| Tags `/dashboard/settings/tags` | ✅ | ✅ E2E settings |
| Quick Replies `/dashboard/settings/quick-replies` | ✅ | ✅ E2E settings |
| Statuses `/dashboard/settings/statuses` | ✅ | ✅ E2E settings |
| SSO `/dashboard/settings/sso` | ✅ | ✅ config persist |
| AI Agent `/dashboard/settings/ai-agent` | ✅ | ✅ E2E settings |
| Announcements `/dashboard/settings/announcements` | ✅ | ✅ E2E settings |
| Help Center `/dashboard/settings/helpcenter` | ✅ | ✅ E2E faq-helpcenter |
| HC Announcements `.../helpcenter-announcements` | ✅ | ✅ E2E settings |
| Profile `/dashboard/profile` | ✅ | ✅ E2E |
| Helpcenter public `/helpcenter/:slug` | ✅ | ✅ E2E render |

### 12.2 Key files referenced
- Routing/layout: `frontends/admin-dashboard/src/App.tsx`
- Nav/permissions: `src/config/navigation.ts`, `src/hooks/usePermissions.ts`, `src/components/organisms/ProtectedRoute/ProtectedRoute.tsx`
- Auth: `src/services/authService.ts`, `src/services/apiClient.ts`, `src/store/slices/authSlice.ts`
- Session: `src/store/slices/sessionSlice.ts`, `src/components/SessionProvider.tsx`, `src/components/SessionWarning.tsx`
- Services: `src/services/*.ts` (≈40 feature services)
- Backend tests: `services/ticket-service/tests/smartViewFilters.test.ts`, `services/webhook-service/src/*.test.ts`, `services/integration-service/src/*.test.ts`, `services/email-ticketing-service/src/__tests__/*`
- Infra: `infra/docker-compose.yml`, `infra/port-registry.json`, `database/migrations`
- CI: `Jenkinsfile`, `Jenkinsfile.consul`, `Jenkinsfile.docker-agents`
- Existing manual checklist: `TESTING_CHECKLIST.md`

### 12.3 Environment variables (E2E)
```
E2E_BASE_URL=http://localhost:3000
E2E_ADMIN_EMAIL=admin@e2e.test
E2E_ADMIN_PASSWORD=...
E2E_AGENT_EMAIL=agent@e2e.test
E2E_AGENT_PASSWORD=...
E2E_LIMITED_EMAIL=limited@e2e.test
E2E_LIMITED_PASSWORD=...
```
