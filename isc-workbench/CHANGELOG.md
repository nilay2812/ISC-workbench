# 0.9.3

- Add Reload from ISC and Compare with Latest ISC in connected editor toolbars and the Command Palette; conflict notifications link to both actions.
- Keep unsaved edits and reject stale writes. Reload confirms discarding dirty edits and refreshes the comparison baseline; comparison alone never rebases edits or submits a write.
- Reopening clean connected items fetches fresh data. Closing an item evicts its cached baseline; reopening no longer requires Developer: Reload Window.
- Use readable item-name tab filenames without appended hashes. URI metadata still distinguishes API IDs, environments, versions and item kinds.
- Release clone progress/busy guards immediately after job completion, without waiting for dismissal of the completion notification. Apply the same fix to related action/creation/save notices.
- Add Copy Source Target Name to normal and SaaS source rows in the main tree. Read exact source names or source-ID-filtered recent aggregation task targets; do not invent legacy IDs or automatically aggregate.
- 133 offline tests passed. Live-tenant and desktop acceptance testing remain outstanding.

# 0.9.2

- Remove the separate Operations view and its navigation commands.
- Embed execution history below each workflow; add provisioning activities under environments and identities.
- Keep normal workflow editing and source aggregation actions.
- Resolve SaaS source editors with a filtered name lookup; share list requests through a short cache. Detail reads remain fresh.
- 124 offline tests; desktop/live performance remains unverified.

# 0.9.1

- Replace the generated Operations focus command with an explicit TreeView and reveal; add Open Operations and stable root nodes.
- Validate the contributed view ID and navigation in regression tests.
- Move saved creation drafts to SecretStorage. Migrate legacy draft state only after successful storage; serialize concurrent saves.
- Add DATA-HANDLING.md describing actual network and storage boundaries.
- 123 offline tests; desktop error reproduction/live-tenant acceptance remain unverified.

# 0.9.0

- Add read-only Operations sidebar: aggregation jobs/progress, provisioning activity diagnostics, workflow run history and certification campaign dashboard/report statuses.
- Add source, identity and workflow context shortcuts, explicit pagination, filters and refresh/reset controls.
- Cancellable aggregation polling with account/identity counts, terminal-state handling and bounded duration.
- SaaS source instances now resolve and open the actual source through the normal connected editor; ambiguous matches offer Find Source.
- Preserve manual-save-only writes and immediate SaaS log streaming.
- 120 offline tests; no live-tenant or desktop acceptance claimed.

# 0.8.2

- Block Auto Save at the connected filesystem boundary. Require one-use explicit-save intent before any resource, script, draft or SaaS document can submit changes.
- Stream source logs immediately without time/level prompts, starting at the click timestamp; exclude earlier events even during overlap polling.
- Remove Stop All Source Log Streams from the view toolbar; retain per-source stop actions.
- 109 offline regression tests; live desktop/tenant acceptance remains outstanding.

# 0.8.1

- Show main source log actions only for uniquely matched SaaS source instances; preserve other source actions and child folders.
- Open SaaS items as connected JSON documents. Save connector alias, customizer name or instance customizer link directly through the API.
- Reject unsupported field changes, unknown customizer IDs, stale remote edits and writes while locked. Block repeat saves after uncertain failures.
- 107 offline tests; live tenant and desktop acceptance remain outstanding.

# 0.8.0

- Add SaaS Connectivity tree sharing tenant credentials and locks.
- Custom connector/customizer create, rename, delete, ZIP version upload and build/deploy.
- Customizer linking/unlinking on SaaS source instances.
- Fetch and follow platform logs in Output with level/time filters, continuation tokens, overlap deduplication and stop controls.
- Bundle attributed SailPoint connector/customizer project templates; add npm build/debug commands.
- Add local/deployed connector testing, JSON/source/spec configuration, literal .env overlays and in-memory replay.
- Enforce Workspace Trust, write locks, explicit invocation/upload confirmation, local-only test origin and best-effort output redaction.
- Add 23 SaaS offline regression tests (103 total). Live tenant/desktop acceptance remains outstanding.

# 0.7.1

- Use refresh and plus icons for all folder hover actions; retain descriptive tooltips.
- Clone behavior unchanged.

# 0.7.0

- Configuration exports use server-produced SP-Config envelopes, selected by item ID or collection type.
- Source cloning shares the export path and uses beta SP-Config as in the reference.
- Multipart import options is a JSON text field; data remains a JSON file; backups remain enabled.
- Clone errors identify preview versus apply and do not retry failed submissions.
- Item-specific context labels with the product prefix removed from command titles.
- 80 offline tests, including serialized multipart verification; live clone success remains unverified.

# 0.6.0

- Dedicated clone, JSON export and deletion menus for supported resources; enable/disable for roles and access profiles.
- Same-tenant SOURCE SP-Config cloning with name-collision check, preview and backup-enabled import; ancillary configuration exclusions shown explicitly.
- Provisioning policies fetched once without offset/limit parameters.
- Source and API write action results use readable notifications rather than JSON result tabs.
- Stable inline lock position; tenant deletion moved to right-click menu.
- 74 offline tests; no live validation of the new clone flows.

# 0.5.0

- Immediate creation on completed dialog inputs; no initial save requirement.
- Tenant connector choices with automatic first-load cache and PAT-owner default.
- Robust offset progression for short server pages, total-count termination and repeated-page detection.
- Source context actions: optimized/unoptimized aggregation, connection test and cluster ping.
- Bound Resource API Actions picker for resource context menus.
- Collection 404 compatibility fallback with correct detail version binding; explicit 403 access explanation.
- 66 offline regression tests; live connection blocked in this environment.

# 0.4.0

- Immediate local creation drafts: name/type prompts, first-save POST, subsequent saves bound to the returned ID.
- Reuse reference transform/rule templates and 37 transform snippets with MIT attribution.
- Persist creation receipts to prevent duplicate POST after reload or uncertain network results.
- Show all fetched source/configuration rows; retain pagination for large identity/account/entitlement collections.
- Fresh Find Source lookup across API versions, display-alias matching, and diagnostic reports.
- Explicit cached connector-type refresh instead of blocking each creation on tenant inventory.
- Separate connector-rule script editing and workflow enable/disable actions.
- Preserve required IDs on PUT updates, including connector rules.
- 59 offline tests; feature comparison and limitations documented.

# 0.3.0

- Alphabetical environment, collection, and resource ordering; cross-page sorting and cached page navigation.
- Create Resource opens a name/type or required-field wizard, creates through the API, then opens the actual resource directly.
- Source connector selection and exact PAT-owner resolution; fallback owner selection when required.
- Display names remain separate from API resource IDs, including immediately after creation.
- Closed-lock/read-only and open-lock/writable icons and corresponding actions.
- Copy Resource ID and Refresh Collection controls.
- API-only file-upload creation and specialized formats remain accessible through advanced API search.

# 0.2.0

- Connected resource editors: Ctrl+S / Cmd+S saves directly to ISC using the documented update method, with no Publish dialog.
- Environment lock toggle, dynamic read-only file permissions, and current-lock enforcement during writes.
- Auto Save follows the same save-through behavior when enabled in VS Code.
- Minimal nested JSON Patch changes, stale-resource checks, sequential-save baselines, and uncertain-write protection.
- Source schemas and provisioning policies in the resource tree.
- API Catalog hidden by default; API search remains in the Command Palette.
- Reject tenant website URLs and record credential-free OAuth failure diagnostics.
- Existing environment records and credentials retain the same storage keys.

# 0.1.0

Initial preview: environment connections, API catalog, explicit resource publication, and reviewed SP-Config promotion.
