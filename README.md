# qa-framework

Enterprise test framework for the Support Portal. It drives the product as a
**black box** (REST APIs + a real browser) and is **feature-registry driven**, so
adding a feature automatically adds it to the integration suite.

> This directory is self-contained and can be moved into its own repository
> (`support-portal-qa`) unchanged. CI then checks out the product repo (to run
> the stack) and this repo (to run the tests).

## Concepts

- **Feature manifest** (`features/*.feature.yaml`): declares a feature's group,
  owner, severity, tags, dependencies, layers, required data, and its
  **behaviours** (the expected behaviours + the spec/test that implements each).
- **Behaviour**: one verifiable expectation. Each behaviour names a `spec` and a
  `testName`. API behaviours are implemented with `defineFeature(id, s => s.behaviour(id, fn))`;
  UI behaviours are Playwright `test("<testName>", ...)`.
- **Registry**: auto-discovers all manifests. `qa validate` fails on manifest
  drift, malformed ownership/metadata, or a spec not registered by a behaviour.
- **Reporting**: features/groups/tags can be run independently; a **feature-wise**
  report (JSON + JUnit + HTML) is written to `reports/<runId>/`, and can be
  **emailed / Slacked** on failure.

## Commands

```bash
npm install
npx playwright install --with-deps

npx qa list                 # show the feature/behaviour matrix
npx qa validate             # schema + drift checks (fails CI on drift)
npm run gen:matrix          # regenerate the automation operator/pairwise matrices

npx qa run --feature auth --env local
npx qa run --group core --env local
npx qa run --tag smoke --env ci --report email
npx qa run --suite integration --env staging --report both
npx qa run --feature tickets --layer api --dry-run
npx qa run --feature webchat-automation --env local   # webchat → automation loop
npx qa run --feature automation-filter-actions --env local   # filters × operators × all actions (create + update triggers)

npx qa report --latest
npx playwright test          # run the UI layer (*.ui.spec.ts)
```

## Adding a new test

Everything is declared in the feature manifest, then implemented. Nothing in
the runner or report needs editing — new behaviours appear automatically in
`qa list`, `qa validate`, and the HTML/JSON/JUnit reports.

### 1. Declare the behaviour (`features/<feature>.feature.yaml`)

```yaml
behaviours:
  - id: tickets.create.with_required_fields   # unique; the spec registers it
    description: Creating a ticket with platform+app succeeds  # → "Expected behaviour" in reports
    spec: specs/tickets/tickets.spec.ts       # file implementing it
    testName: "creates a ticket"              # exact test title (drift-checked by qa validate)
    severity: P0                              # P0/P1 failures block the run verdict
    layers: [api]                             # api and/or ui
```

Reuse an existing feature file to add tests to a feature you know; create a
new `features/<id>.feature.yaml` only for a genuinely new domain.

### 2. Implement it

**API test** (`layers: [api]`) — in the feature's `specs/<feature>/<feature>.spec.ts`:

```ts
import { defineFeature } from "../../src/orchestrator/suite.js";
import { assert } from "../../src/orchestrator/context.js";

const suite = defineFeature("tickets", (s) => {
  s.behaviour("tickets.create.with_required_fields", async (ctx) => {
    await ctx.session.loginAs("admin");              // shared session/cookies
    const api = ctx.api("TICKET");                   // service client (see src/config)
    const res = await api.post("/api/tickets", {
      subject: `e2e-${Date.now()}`,
      platform_id: await resolveWebchatPlatformId(ctx),
    });
    assert(res.status < 400, `create failed: ${res.status}`);
    ctx.addArtifact(`artifacts/tickets/${Date.now()}.json`); // → report evidence
  });
});
export default suite;
```

Create whatever **test data the case needs inside the test** (e.g.
`ensureTag()` in `specs/automation/automationHarness.ts` registers tags via
`POST /api/tags` before rules use them); cleanup helpers remove tracked
resources after the run.

**UI test** (`layers: [ui]`) — in `specs/<feature>/<feature>.ui.spec.ts` as a
Playwright test whose title equals `testName`:

```ts
import { test, expect } from "@playwright/test";

test("UI login reaches the dashboard", async ({ page }) => {
  await page.goto("/login");
  // ...assertions...
  await expect(page).toHaveURL(/\/dashboard/);
});
```

### 3. Validate + run

```bash
npx qa validate                                  # must pass (manifest ↔ spec drift check)
npx qa run --feature tickets --env local         # API + UI behaviours declared for tickets
npx qa run --feature tickets --layer ui --env local # only the Playwright UI behaviours
```

The behaviour is now **auto-included** in `--suite integration`; nothing else
to edit.

## Adding a new feature (whole domain)

1. Create `features/<id>.feature.yaml` with the expected behaviours.
2. Implement API behaviours in `specs/<id>/<id>.spec.ts` (matching ids) and, if
   needed, UI behaviours in `specs/<id>/<id>.ui.spec.ts` (matching titles).
3. Run `npx qa validate` — it must pass.
4. The feature is now **auto-included** in `--suite integration`; nothing else to edit.

## Automation coverage: webchat filters × actions × triggers

`automation-filter-actions` (`features/automation-filter-actions.feature.yaml` +
`specs/automation/filterActions.spec.ts`) proves the rule engine end-to-end for
webchat tickets:

- **Field × operator matrix** (`filteractions.dryrun.field_operator_matrix`):
  every filter the dashboard offers for webchat tickets — `app`, `platform`,
  `language`, `tags`, `subject`, `status`, `priority`, `is_urgent` — evaluated
  against a **matching** *and* a **mismatching** ticket, with **all 12 supported
  actions** attached to every evaluation. Evidence:
  `artifacts/filter-actions/field-operator-matrix.json`.
- **Combinations** (`filteractions.dryrun.condition_combinations`): flat AND
  (implicit for a flat condition array), OR groups, and nested AND/OR groups
  across app × platform × language × tags × subject. Evidence:
  `artifacts/filter-actions/condition-combinations.json`.
- **Live creation** (`filteractions.real.*`): a real webchat ticket satisfying
  *app is* + *platform is one of* + *language is* fires a real rule carrying all
  actions — tag, custom field, reply and note are asserted strictly, as is the
  status transition; a ticket missing one dimension stays untouched.
- **Issue UPDATE triggers** (`filteractions.update.*`): the product disables the
  generic `ticket_updated` rule type and **derives** concrete triggers from
  update events (`ticket_status_changed`, `tag_added`, `tag_removed`,
  `custom_field_changed`, `ticket_assigned`, …). The tests assert creation alone
  does **not** fire such a rule, then that a real `PUT /api/tickets/:id` does.

### UI Test Execution (Playwright)

To run the UI layer tests against the running local docker stack:

```cmd
scripts\run-ui-tests.cmd
```

Or pass a specific spec:

```cmd
scripts\run-ui-tests.cmd specs/auth/auth.ui.spec.ts
```

`qa run` is the release-gate command: it invokes Playwright for selected UI
behaviours and merges the result into the same JSON/JUnit/HTML feature report.
Use `npx playwright test` only while authoring or debugging a UI test.

This resolves the reverse-proxy IP within the `infra_default` docker network, routes `mycompany.clariconops.test`, and launches Playwright with the configured credentials.


Filter/operator/value catalogs live in `src/domain/webchatFilterCatalog.ts`,
mirroring the dashboard's `AutomationRuleBuilder/constants.ts` and the
`services/automation-service` validators; `npm run gen:matrix` regenerates the
operator/pairwise matrices.

## Report output

```
reports/<runId>/
  summary.json   # machine-readable, severity-weighted
  summary.html   # human-readable: feature summary + per-test details
                 # (expected behaviour, result, error, evidence links)
  junit.xml      # CI-native
  features/*.json
  meta/run.json  # env, git sha, selection
```

## Configuration

Copy `.env.example` to `.env.local` / `.env.ci` / `.env.staging` and set service
URLs + credentials. Nothing points at product source — only HTTP/WS URLs.

Runs are intentionally blocked against `prod`, `production`, and `prod-like`.
For staging, set `QA_ALLOW_DESTRUCTIVE=true` explicitly. Rules/tickets created
by specs must be tracked and are cleaned up at the end of the run; the per-run
outcome is written to `meta/cleanup.json`.

For notifications: set `QA_EMAIL_ENABLED=true` (+ `QA_SMTP_*`, `QA_EMAIL_TO`) and/or
`QA_SLACK_WEBHOOK`. Send on failure by default (`QA_NOTIFY=always` to always send).

## Governance

- **Severity policy**: P0/P1 failures block the verdict; P2/P3 are reported.
- **Quarantine**: known flakes go in `quarantine.yaml`; they run but don't block.
  Every entry must have an owner, issue link, rationale, and expiry before a
  release manager can approve it.
- **CI**: see `docs/ENTERPRISE_TEST_FRAMEWORK.md` §10 for the Jenkins wiring.
