# Enterprise Test Framework — Support Portal

**Codename:** `qa-framework`
**Status:** Design + scaffold
**Repo model:** Standalone repository (`support-portal-qa`) that drives the Support Portal (UI + microservices) as a black box over HTTP/WebSocket and a real browser. It does **not** import application source, so it can run against local Docker Compose, CI, staging, or AWS without code coupling.

---

## 1. Vision & Principles

We are not adding "some tests". We are building an **enterprise test platform** with the following principles:

1. **Feature-first, not file-first.** Every test is attached to a *feature manifest*. The system knows what a "feature" is, its owner, severity, group, and expected behaviours.
2. **Add-a-feature = add-a-manifest.** When a new dashboard capability ships, the author adds a feature manifest + specs. It is **auto-discovered and auto-included** in the integration suite. No central file to edit.
3. **Run any slice.** Execute a single feature, a group of features, a tag (smoke/regression), an entire service integration, or the whole end-to-end suite from one CLI.
4. **Evidence, not opinions.** Every failure produces artifacts (screenshots, video, trace, HAR, service logs, API request/response) and a **feature-wise report** written to a run directory and optionally **emailed/Slacked**.
5. **Environment-agnostic.** The same suite points at `local | ci | staging | prod-like` via configuration; no test code changes.
6. **Deterministic & isolated.** Each feature owns and cleans its data; runs are repeatable and parallelizable.
7. **Governance baked in.** Severity, ownership, and pass/fail SLAs are first-class, so a red run has meaning.

---

## 2. Requirements → Capability Mapping

| Requirement (from stakeholders) | Framework capability |
|---------------------------------|----------------------|
| "test individual feature / group of features / entire setup" | **Scopes & selectors**: `--feature`, `--group`, `--tag`, `--suite integration`, `--all` |
| "as we add a new feature… add expected behaviour… auto-added to integration suite" | **Feature Registry** auto-discovery + **drift validation** (`qa validate`) |
| "on failure, detailed report feature-wise, emailed or saved to a directory" | **Reporting Engine** → `reports/<runId>/` (JSON/JUnit/HTML) + **Email/Slack** notifier |
| "could stay in another repo but interacts with our code" | **Black-box adapters** (API + UI page objects) over HTTP/WS; env-driven endpoints |
| "enterprise level" | Severity/owners, retries, flake quarantine, CI gates, artifact retention, dashboards |

---

## 3. Architecture Overview

```
                       ┌───────────────────────────────────────────────┐
                       │                qa-framework CLI                 │
                       │  run | list | validate | report | seed | clean   │
                       └───────────────┬───────────────────────────────┘
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
        ▼                              ▼                               ▼
┌───────────────┐            ┌──────────────────┐            ┌──────────────────┐
│ Feature        │            │ Test Orchestrator │            │ Reporting Engine │
│ Registry       │──select──▶ │ (runs by layer)   │──result──▶ │ (feature-wise)   │
│ (manifests)    │            │ api/ui/contract   │            │ json/junit/html  │
└───────────────┘            └────────┬──────────┘            └────────┬─────────┘
                                      │                                │
                     ┌────────────────┼──────────────┐                ▼
                     ▼                ▼              ▼        ┌──────────────────┐
              ┌───────────┐   ┌────────────┐  ┌───────────┐   │ Notifiers        │
              │ API Client│   │ UI (PW)    │  │ Contract  │   │ Email / Slack /  │
              │ (per svc) │   │ Page Obj.  │  │ (schema)  │   │ Webhook          │
              └─────┬─────┘   └─────┬──────┘  └─────┬─────┘   └──────────────────┘
                    │               │               │
                    ▼               ▼               ▼
        ┌───────────────────────────────────────────────────────────┐
        │      System Under Test (black box)                         │
        │  admin-dashboard UI · 13 microservices · Postgres/Redis/Kafka│
        └───────────────────────────────────────────────────────────┘
```

### 3.1 Layers

| Layer | Tech | Purpose | Scope example |
|-------|------|---------|---------------|
| **API / Service** | axios + typed clients | Exercise each microservice REST API | `--layer api` |
| **UI / E2E** | Playwright + Page Objects | Real browser journeys | `--layer ui` |
| **Contract** | JSON Schema / OpenAPI diff | Detect API drift the UI depends on | `--layer contract` |
| **Integration (cross-service)** | API + Kafka/WS assertions | End-to-end business flows | `--suite integration` |
| **Performance** (optional) | k6 | SLA/load checks | `--layer perf` |

### 3.2 Standalone repo layout

```
support-portal-qa/
  package.json
  tsconfig.json
  framework.config.ts          # global defaults
  .env.example                 # env contract
  .env.local / .env.staging    # per-env (git-ignored, provided by CI/secrets)
  README.md

  src/
    cli.ts                     # CLI entry (commander)
    config/
      env.ts                   # typed env loader/validator
      targets.ts               # environment/target definitions
    registry/
      types.ts                 # FeatureManifest types
      load.ts                  # discover manifests
      select.ts                # resolve scopes/tags/groups
      validate.ts              # drift check manifest <-> specs
    orchestrator/
      run.ts                   # plan + execute selected tests
      layers.ts                # layer runners (api/ui/contract)
      retry.ts                 # retry + quarantine policy
    api/
      http.ts                  # axios base + auth + interceptors
      sessionClient.ts
      ticketsClient.ts
      queuesClient.ts
      ...                      # one client per service
    ui/
      pages/                   # Playwright Page Objects
      components/              # reusable UI fragments
      auth.ts                  # login/storageState helpers
    fixtures/
      factories.ts             # makeUser/makeTicket/makeQueue
      seed.ts                  # programmatic seeding via API
      teardown.ts              # cleanup by tag/prefix
      dbReset.ts               # optional DB reset hook
    reporting/
      collector.ts             # aggregate results by feature
      junit.ts                 # JUnit XML
      html.ts                  # self-contained HTML report
      email.ts                 # SMTP / Graph API notifier
      slack.ts                 # webhook notifier
      artifacts.ts             # copy screenshots/videos/traces/HAR/logs
    utils/
      logger.ts
      wait.ts                  # polling helpers (WS, async)
      ws.ts                    # WebSocket test client

  features/                    # <-- ADD FEATURES HERE (auto-discovered)
    auth.feature.yaml
    tickets.feature.yaml
    smart-views.feature.yaml
    queues.feature.yaml
    routing.feature.yaml
    automation.feature.yaml
    team-roles.feature.yaml
    faq-helpcenter.feature.yaml
    tags-custom-fields.feature.yaml
    bots-ai-agent.feature.yaml
    apps-announcements.feature.yaml
    analytics-billing.feature.yaml
    permissions.feature.yaml
    multi-tenant.feature.yaml
    settings.feature.yaml

  specs/                       # implementations referenced by manifests
    auth/auth.spec.ts
    tickets/tickets.spec.ts
    ...
  contract/
    schemas/*.schema.json
  reports/                     # output root (git-ignored): reports/<runId>/
  playwright.config.ts
  docker/
    docker-compose.test.yml    # optional: spin the stack from the QA repo
```

---

## 4. Feature Registry & Auto-Registration

This is the heart of the "new feature automatically joins the suite" requirement.

### 4.1 Manifest schema (`features/*.feature.yaml`)

```yaml
id: tickets
title: Tickets Management
group: core                     # core | workflows | data | people | integrations | platform
owner: support-core@company.com
severity: P1                    # P0 (critical path) | P1 | P2 | P3
tags: [smoke, regression, api, ui]
dependsOn: [auth, queues]       # selection closure + ordering
layers: [api, ui]
environments: [local, ci, staging]

# Expected behaviours — the contract of the feature.
behaviours:
  - id: tickets.list.loads
    description: Ticket list loads and shows pagination
    spec: specs/tickets/tickets.spec.ts
    testName: "list loads with pagination"
    severity: P1
  - id: tickets.reply.public
    description: Agent can send a public reply that persists
    spec: specs/tickets/tickets.spec.ts
    testName: "sends public reply"
    severity: P0
  - id: tickets.status.change
    description: Status change persists and emits event
    spec: specs/tickets/tickets.spec.ts
    testName: "changes status"
    severity: P1

# Data required for this feature's tests.
data:
  seeds: [tenant, users, queue, tickets]
  cleanup: true

# Non-functional
timeoutMs: 90000
```

### 4.2 What the registry gives us

- **Discovery:** `load.ts` globs `features/**/*.feature.yaml`, validates against the schema, builds `Map<featureId, FeatureManifest>`.
- **Selection:** `select.ts` resolves a run plan from selectors (`--feature tickets --group workflows --tag smoke`), expanding `dependsOn` so prerequisites (e.g. `auth`) always run first.
- **Drift validation:** `qa validate` fails if:
  - a `behaviour` references a spec/test that does not exist (missing implementation), or
  - a spec test is not declared by any behaviour (untracked test), or
  - a manifest is malformed / duplicate id.
  This guarantees **the manifest and the tests never diverge** — adding a feature without a manifest (or vice versa) breaks the build.
- **Catalog:** `qa list` prints the full feature/behaviour matrix, used by reporting and by humans to see coverage.

### 4.3 The "new feature" workflow

1. Developer adds feature manifest `features/my-new-feature.feature.yaml` with expected behaviours.
2. Developer adds the spec(s) under `specs/my-new-feature/`.
3. `qa validate` passes (behaviour ↔ test wiring verified).
4. On the next `--suite integration` (or nightly) run, the feature is **automatically included**. Nothing else to edit.

> Optional stronger mode: **manifest-first TDD** — behaviours can be declared before specs exist; `qa validate --mode pending` lists implemented-but-failing vs not-yet-implemented behaviours, so QA can track pending implementations explicitly.

---

## 5. Scopes & Selection (CLI)

```
# Single feature
qa run --feature tickets --env local

# Group of features
qa run --group workflows --env staging

# Tag-based suites
qa run --tag smoke                 # fast pre-merge
qa run --tag regression            # broad nightly

# Entire integration suite (all features, all layers)
qa run --suite integration --env ci --report email

# Layer-focused
qa run --feature tickets --layer api
qa run --feature tickets --layer ui

# Discovery / validation / reporting
qa list [--format table|json]      # print feature matrix
qa validate                        # drift + schema checks
qa report --run-id 2026-09-20T15-30 --open
qa seed --feature tickets          # provision data only
qa clean --prefix e2e-             # teardown
```

**Selection precedence:** explicit `--feature` > `--group` > `--tag` > `--suite`. Dependencies are always pulled in (`--no-deps` to opt out for speed).

---

## 6. Test Execution Engine

### 6.1 Run plan
`orchestrator/run.ts` builds a plan: ordered list of behaviours grouped by feature and layer, with dependency ordering and severity weighting. It emits a `RunContext` (runId, env, target, selection, startedAt).

### 6.2 Layer runners
- **API runner:** executes behaviours whose layer is `api` using the per-service clients; collects request/response pairs as artifacts.
- **UI runner:** drives Playwright; behaviours map to `test()` titles inside specs; global setup does auth `storageState` per role; `trace/video/screenshot` on failure.
- **Contract runner:** fetches/serves OpenAPI or module schemas and diffs against committed `contract/schemas/*` — fails on breaking change.

### 6.3 Resilience
- **Retries:** configurable per-severity (e.g. P0 no retry to surface flakiness; P2/P3 up to 2).
- **Quarantine:** a `quarantine.yaml` list of known-flaky behaviour ids; they run but do not fail the pipeline (reported separately) until fixed.
- **Parallelism:** API layers parallel; UI serial per tenant or sharded by worker with isolated tenants.
- **Timeouts:** per-feature (`timeoutMs`) and global.

---

## 7. Data Management

- **Factories** (`fixtures/factories.ts`): `makeTenant`, `makeUser(role)`, `makeQueue`, `makeTicket`, `makeFaq`, `makeTag`… returning typed objects with deterministic `e2e-` prefixed IDs.
- **Seeding** (`fixtures/seed.ts`): provisions everything a selected feature needs via **public APIs** (preferred) or optional direct DB reset for a clean slate.
- **Isolation:** each feature/worker gets its own tenant or data namespace; tests never assert against shared mutable data.
- **Teardown** (`fixtures/teardown.ts`): deletes by prefix; runs in `globalTeardown` and on `qa clean`.
- **External stubs:** Mailgun (email), S3 (files), FCM (push) are stubbed at the service boundary via env flags so E2E is hermetic.

---

## 8. Reporting Engine (feature-wise, artifacts, email)

### 8.1 Output layout

```
reports/
  2026-09-20T15-30-05_run-a1b2/
    summary.json                 # machine-readable, severity-weighted
    summary.html                 # human-readable dashboard
    junit.xml                    # CI-native
    features/
      tickets.json
      tickets.html
      automation.json
      ...
    artifacts/
      tickets/
        tickets.reply.public/
          screenshot.png
          video.webm
          trace.zip
          api.har
          service-logs.txt
    meta/
      run.json                   # env, target, git sha, selection
      environment.txt
```

### 8.2 Feature-wise summary (example `summary.json`)

```json
{
  "runId": "2026-09-20T15-30-05_run-a1b2",
  "env": "staging",
  "gitSha": "1e69e1d",
  "startedAt": "2026-09-20T15:30:05Z",
  "finishedAt": "2026-09-20T15:41:12Z",
  "totals": { "features": 15, "behaviours": 128, "passed": 121, "failed": 5, "skipped": 2 },
  "byFeature": [
    { "id": "tickets",    "severity": "P1", "passed": 24, "failed": 2, "status": "FAILED",
      "failures": ["tickets.reply.public", "tickets.attachment.upload"] },
    { "id": "automation", "severity": "P1", "passed": 8,  "failed": 3, "status": "FAILED",
      "failures": ["automation.rule.execute", "..."] },
    { "id": "faq-helpcenter", "severity": "P2", "passed": 9, "failed": 0, "status": "PASSED" }
  ],
  "verdict": "FAILED",
  "blockingFailures": 5
}
```

### 8.3 Email / Slack notifier

Triggered by `--report email`, `--report slack`, `--report both`, or config default. Sends **on failure** (default) or always (`--notify always`).

Email content:
- **Subject:** `[QA][staging] FAILED — 5 failures across 2 features (run a1b2)`
- **Body (HTML):** feature-wise table (feature, severity, passed/failed, top failing behaviours), link to the HTML report, git sha, environment, duration.
- **Attachment:** `summary.html` (or `junit.xml`), and optionally a zipped `reports/<runId>/`.
- **Recipients:** per-feature owners (from manifest `owner`) get a focused email for *their* feature; a distribution list gets the overall.

Transport options (config-driven):
- **SMTP** (`nodemailer`) via `QA_SMTP_*`.
- **Microsoft Graph** (`sendMail`) for Office 365.
- **Slack** incoming webhook (`QA_SLACK_WEBHOOK`) with the same summary.
- **Generic webhook** for integration into other systems (Jira/ServiceNow).

### 8.4 CI artifacts
Publish `reports/<runId>/` + `junit.xml` + `summary.html` as Jenkins/GitHub artifacts; keep N runs (`retention`) and upload `summary.json` as build metadata for trend dashboards.

---

## 9. How It Interacts With The Application (no code coupling)

The framework treats the product as a **black box** and only depends on stable interfaces:

| Dependency | Direction | Mechanism |
|------------|-----------|-----------|
| Service REST APIs | QA → services | base URLs from env (`QA_TENANT_SERVICE_URL`, etc.) |
| Dashboard UI | QA → web | Playwright `baseURL` |
| WebSocket/real-time | QA → gateway | `ws://` URL from env |
| Auth | QA → session-service | real login to obtain cookies/JWT |
| Test data | QA → public APIs | factories + seed/teardown scripts |
| DB reset (optional) | QA → Postgres | direct connection for a clean slate (`QA_DB_*`) |
| Email/S3/FCM stubs | services ← env | service-level flags so E2E stays hermetic |

**Contract guards:** the framework owns `contract/schemas/*.json`. A `--layer contract` run fetches live responses and diffs them; any breaking change the UI relies on fails fast. This is the *only* place the framework encodes "expected API shape", and it lives entirely on the QA side.

**Version pinning:** `meta/run.json` records the product's `gitSha` (passed via `QA_GIT_SHA`), so a report is always attributable to a build.

> Extraction: because there is zero import of product source, the `qa-framework/` directory can be moved to its own repository unchanged; CI simply checks out the product repo (for the stack) and the QA repo (for tests).

---

## 10. CI/CD Integration

### 10.1 Pipelines

| Pipeline | Trigger | Scope | Blocking? |
|----------|---------|-------|-----------|
| **PR smoke** | every PR | `qa run --tag smoke --env ci` (auth + core CRUD) | yes |
| **Merge/nightly regression** | merge to main / cron | `qa run --suite integration --env staging --report email` | yes |
| **Release gate** | before prod deploy | `qa run --tag regression --env staging --report both` | yes |
| **On-demand** | manual | any selector (`--feature`, `--group`) | no |

### 10.2 Jenkins (existing infra)

```
stage('QA: Validate manifests')  { sh 'npx qa validate' }
stage('QA: Smoke')               { sh 'npx qa run --tag smoke --env ci --report junit' }
stage('QA: Integration')         { sh 'npx qa run --suite integration --env staging --report email' }
stage('QA: Publish')             { publishHTML(...); archiveArtifacts 'reports/**' }
```

Gate deploy with `when { expression { currentBuild.result == 'SUCCESS' } }`.

### 10.3 Running against environments
`--env` selects `.env.<env>` + a target definition:
- `local` → Docker Compose (`localhost:5173`, `:4005–:4030`)
- `ci` → ephemeral Compose in the runner
- `staging` → AWS staging URLs
- `prod-like` → read-only smoke only (`--tag smoke`)

---

## 11. Governance & Enterprise Controls

- **Severity policy:** P0 failures always block; P1 block on main; P2/P3 report-only by default.
- **Ownership:** each feature manifest declares an `owner`; reports and notifications route to them.
- **Flake quarantine:** `quarantine.yaml` holds known-flaky behaviour ids; excluded from the verdict but shown, with a burndown.
- **Retention & trends:** keep the last N runs; `summary.json` feeds dashboards (pass rate, flake rate, MTTR per feature).
- **Auditability:** every run stores env, selection, git sha, artifacts — reproducible and explainable.
- **Security:** secrets only via env/CI credentials; no credentials in manifests or specs.

---

## 12. Implementation Roadmap

| Phase | Deliverable | Exit criteria |
|-------|-------------|---------------|
| **0. Bootstrap** | QA repo scaffold, config/env, CLI (`run/list/validate`) | `qa list` renders the matrix; `qa --help` works |
| **1. Registry** | manifest schema + loader + selection + `validate` | drift check fails on missing spec; smoke selectable |
| **2. API layer** | session/tickets/queues clients + factories + seed | `qa run --feature auth --layer api` green locally |
| **3. Reporting** | collector + JSON/HTML/JUnit + artifact capture | feature-wise `summary.html` produced on failure |
| **4. Notifier** | SMTP/Graph + Slack + routing to owners | failed run emails the right owners with the report |
| **5. UI layer** | Playwright page objects + auth storageState | `--layer ui` critical journeys pass locally |
| **6. Feature rollout** | manifests+specs for all 15 features | `--suite integration` covers 100% of pages |
| **7. CI wiring** | PR smoke + nightly integration + gate | deploy blocked on red; artifacts published |
| **8. Hardening** | quarantine, retries, trend dashboards | flake rate < 2%; suite < 20 min |

---

## 13. Quick Start (once scaffolded)

```bash
# 1) install
npm install
npx playwright install --with-deps

# 2) configure
cp .env.example .env.local         # set service URLs + credentials

# 3) discover
npx qa list
npx qa validate

# 4) run a single feature against local
npx qa run --feature auth --env local

# 5) run a group + open the report
npx qa run --group workflows --env local --report html
npx qa report --latest --open

# 6) full integration with email
npx qa run --suite integration --env staging --report email

# 7) add a new feature (auto-discovered next run)
$EDITOR features/my-new-feature.feature.yaml
$EDITOR specs/my-new-feature/my-new-feature.spec.ts
npx qa validate
```

> A runnable scaffold (CLI, registry, a sample feature manifest, a sample API + UI spec, and the reporting/email modules) is included under `qa-framework/` in this repo and can be lifted into its own repository as-is.


