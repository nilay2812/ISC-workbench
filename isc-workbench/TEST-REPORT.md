# 0.9.3 validation

133 offline tests passed, including previous Auto Save, permissions, pagination and promotion gates. New tests cover fresh reloads without writes, dirty-edit cancellation, edits during reload, read-only comparisons without baseline changes, readable unique resource URIs, clone completion while a notification remains open, failed-clone cleanup, source-ID-scoped target-name lookup and no invented names/automatic aggregations.

Desktop rendering, actual VS Code revert behavior, and live tenant responses have not been exercised for this release. Offline mocks are not a substitute for those acceptance checks.

# ISC Workbench 0.9.2 — verification record

Build date: 10 September 2026.

## Passed

- JavaScript syntax checks for every runtime module.
- **124 offline automated tests**, using Node's test runner. No tenant credentials or remote writes were used.
- Catalog enumeration: **3,315 versioned operation entries**, including **864 v2026 operations**.
- Every catalog operation resolves, has a response specification, and produces a serializable editable request draft.
- All bundled references resolve across v2026, v2025, v2024, v3, and beta.
- VS Code command registration and representative workflows using a mocked VS Code API.
- OAuth caching/concurrency, credential separation, read-only enforcement, tenant-origin restrictions, blocked credential-header overrides, query serialization, redaction, binary responses, and no automatic write retries.
- Transform editing through a documented update method, stale remote edit rejection, explicit mapping checks, signed object protection, and duplicate-name rejection.
- Promotion target drift rejection, preview-error blocking, exact target confirmation, fresh preview, backup retrieval, and partial-import error reporting.
- Standard VSIX packaging through `@vscode/vsce`, with production dependencies excluded because the runtime has none.

## Embedded diagnostics and source-navigation regression checks

- Workflow/identity child folders and environment provisioning activity entry; manifest has no Operations view or Open Operations command.
- Exact filtered SaaS source resolution instead of full inventory download.
- Shared SaaS list cache; explicit refresh invalidation and fresh detail reads.

Historical diagnostic helper tests remain; aggregation/certification dashboards are no longer exposed in this release.

- All four Operations groups; paged GET-only requests on locked environments.
- Short-page continuation, preserved query filters and repeated-page rejection.
- Permission failure without fallback; Workspace Trust gate before requests.
- Campaign completion counts, deadlines and report-status route.
- Failed workflow filter and execution history route bound to actual run ID.
- Readable provisioning errors and redaction of keyed secret fields.
- Aggregation terminal completion, zero counts, cancellable timer and aborted request signal.
- Source/identity shortcuts bind actual API IDs.
- SaaS source instance resolves to the normal source editor; ambiguous matches do not open arbitrary sources.

These are mocked API/VS Code fixtures. No Operations API was called against the live tenant, and no desktop acceptance test has been completed. Existing public-release security gates still apply.

## Manual-save and log-start regression checks

- Auto Save reasons AfterDelay and FocusOut are blocked before any mutation; missing or reused manual intent is also blocked. Explicit Save still submits changes. This gate is shared by all connected documents.
- Streaming uses no prompt, starts at click time, filters historical events, and never moves the polling window before that start. The global stop toolbar action is absent.

## SaaS Connectivity regression checks

- Confirmed SaaS-only main source menus, backend/display-name separation and preserved source actions.
- Connected SaaS document saves by immutable ID, lock enforcement, supported-field restrictions, stale edit rejection and customizer validation/unlink payloads.

- Tenant reuse, alphabetical platform lists and friendly access-denied rows.
- Workspace Trust and write-lock enforcement; only platform log queries bypass the write restriction as read operations.
- Alias/name request bodies, ID-bound changes, exact-name deletion, customizer link/unlink patches and ZIP version uploads.
- Stable log filters across continuation pages, overlap deduplication, repeated-token protection, snapshot completion and stream cancellation.
- Common-key/known-value output redaction, NDJSON errors and response-size limits.
- Local-only invocation without ISC Authorization headers or redirect following.
- Remote latest-tag invocation, no persisted test history and lock rechecking on replay.
- Template name substitution, refusal to overwrite existing project folders, and no deployment after build failure.

These tests use mocked services/VS Code APIs. No live SaaS upload, source linking, log stream, deployed invocation, real npm project build or desktop interaction has been verified. Template dependencies need a separate audit. Version 0.9.1 migrates saved drafts into SecretStorage; old backups and file exports are outside that migration.

## Save-through regression checks

- Connected resource file URIs restore their environment/resource binding.
- Ctrl+S uses the documented update endpoint without a modal confirmation.
- Two sequential saves handle server-updated timestamps correctly.
- Source PATCH updates change only the edited nested field and do not resend unchanged password fields.
- Environment lock changes update file permissions and block writes from already-open tabs.
- Invalid JSON and rejected writes retain the document and prior baseline.
- Ambiguous network failures block another save until the resource is reopened.
- Source schema/provisioning-policy folders bind the parent source ID.
- API Catalog is opt-in and hidden by default.
- Tenant website addresses are rejected; OAuth failures are logged without secrets.

## Creation, sorting, and identifier regression checks

- Environment and collection ordering; natural alphabetical sort across API pages.
- Cached navigation avoids refetching the whole collection for each displayed page.
- Closed/open lock icon and menu state track read-only/writable environments.
- Source display names and backend-style labels never replace the API ID in a request.
- Missing API IDs cannot fall back to a display name.
- Source creation resolves the exact PAT owner, submits after dialog completion and opens the returned ID.
- Transform creation submits the upstream template after dialog completion without requiring a save.
- Cancelled wizards and locked environments perform no POST.
- Successful creation followed by a delayed/failed GET reports that creation succeeded and does not retry POST.

## Retained creation-receipt and editor checks

- First-save creation and subsequent updates target one resource; restored receipts preserve the actual ID.
- Ambiguous creation receipts survive reopening and prevent repeated POST.
- All 81 source rows in a fixture are visible, including testing-nilay beyond the former 50-row window.
- Find Source opens a cross-version match by ID; no-match reports do not assert deletion.
- Display aliases do not replace API IDs.
- Connector-rule script saves preserve the required ID in PUT bodies.
- Workflow enable/disable follows the current environment lock.

## Not established

- **Actual VS Code desktop/extension-host smoke test:** attempted, but the downloaded Electron host terminated with SIGSEGV in this container. The archive extraction also reported unsupported ownership restoration. No desktop activation or visual QA pass is claimed. The source includes an optional smoke-test launcher and an F5 development configuration for a normal desktop.
- **Live SailPoint integration:** the credentials supplied in conversation were not used. Authentication, endpoint permissions, live request execution, server-side reference resolution, and cross-tenant promotion have not been tested against a real tenant.
- Offline schema coverage does not establish successful execution of every endpoint, service-specific business rules, or feature entitlement.
- Corporate proxy/custom certificate behavior and Windows/macOS host behavior have not been exercised.

## First sandbox check

1. Install the VSIX in VS Code 1.105.0 or later and open ISC Workbench.
2. Add a sandbox environment and run Test Authentication.
3. Browse a source and transform in read-only mode; run a GET API request.
4. Enable writes only in the sandbox, create a disposable static transform through Create Resource, reopen it, edit its value, and press Ctrl+S to save the update.
5. With a second sandbox/UAT tenant, prepare a promotion containing only that transform. Review its candidate and preview result before confirming import.
6. Verify the imported transform and saved import/backup artifacts. Remove disposable test objects explicitly when finished.

## Reproduce offline checks

```sh
npm ci
npm run check
npm test
npm run package
```

Catalog source commit: `a829aeff963ccc11578b7b26ba42c3bccada8b27`.

## Additional 0.5 checks

- Short pages continue using received-record offsets; reported total count avoids extra requests.
- Repeated pages are rejected rather than duplicated.
- 404 fallback binds resource editors to the successful version.
- 403 returns access diagnostics without fallback.
- Unoptimized aggregation sends multipart disableOptimization=true with the actual source ID.
- Locked source actions cannot send requests.
- Live endpoint reachability attempt did not complete; the execution environment reported network approval cancellation. Credentials were not sent. No live read/write or aggregation validation is claimed.

## Additional 0.6 checks

- Provisioning-policy retrieval sends no pagination parameters and requests the collection once.
- Failed action payloads and accepted asynchronous jobs create notifications without opening editors or displaying raw error bodies.
- Role clones remove the original ID, retain references and start disabled.
- Resource deletion requires the exact name and uses the API ID.
- Source-clone name collisions stop before export/import.
- Source clone rewrites the selected object's ID/name and performs preview before import.
- Lock commands share one fixed menu group; tenant deletion is not inline.

Source cloning and other new tenant mutations have not been live-tested. This remains a preview build with offline validation, not a production security certification.

## Additional 0.7 checks

- SP-Config export preserves the server envelope and scopes the selected item's ID.
- Collection export scopes type and does not manufacture self metadata.
- Wrong-object exports are rejected.
- Context titles name Sources, Roles, Access Profiles and Provisioning Policies without the product prefix.
- Clone preview 500 is labelled correctly, uses beta, and sends no apply or retry.
- Serialized multipart bytes contain data as import.json and options as a text field, with backup enabled.

HTTP 500 causation and live success remain unverified. Corrected request differences are established by inspection against the supplied reference code and local tests.

## 0.7.1 UI patch verification

Manifest inspection confirms refresh/add icons on typed folder commands, preserving inline groups and descriptive titles. The prior 80-test runtime baseline applies; no runtime code changed in this patch. Syntax and package integrity checked. Actual hover rendering requires desktop VS Code.
