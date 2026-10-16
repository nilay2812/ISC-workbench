# ISC Workbench

**Explore every SailPoint Identity Security Cloud API, edit tenant configuration as JSON, and promote changes between environments(in testing), all from VS Code.**

> **Preview release.** ISC Workbench is independent community software. It is not developed, maintained or supported by SailPoint. New environments start **read-only**, so you can look around safely before turning writes on.

## Features

- **Environment tree.** Browse sources, transforms, connector rules, workflows, identity profiles, access profiles, roles, identities, accounts, entitlements, governance groups, applications, forms and machine identities.
- **Edit as JSON, save to the tenant.** Open an item, edit it, press **Ctrl+S** (**Cmd+S** on macOS). Before saving, the extension checks the JSON and blocks the save if someone changed the item in ISC since you opened it.
- **API explorer.** Search all 3,315 operations across v2026, v2025, v2024, v3 and beta. Pick one, edit the request JSON with schema-based completion, and run it with **Ctrl+Alt+Enter**.
- **Reviewed environment promotion.** Move configuration from one tenant to another with SP-Config. You get a comparison, a server-side preview, and a backup before anything is applied.
- **Clone and export.** Clone sources, roles, access profiles, transforms, rules and workflows. Export any supported item as an SP-Config bundle.
- **SaaS Connectivity.** Manage custom connectors and customizers, upload ZIPs, scaffold new projects, test them, and stream source logs.
- **Workflow history and provisioning activity.** Read workflow executions and provisioning activity as readable output.
- **Safety first.** Tenant lock per environment, no Auto Save to ISC, typed confirmation for deletes and promotions, credentials kept in VS Code SecretStorage.

## Getting started

1. Install **ISC Workbench** from the Extensions view (**Ctrl+Shift+X**).
2. Click the shield icon in the activity bar, or run **ISC Workbench: Open Workbench** from the Command Palette (**Ctrl+Shift+P**).
3. Run **Add Environment**. Give it a name such as `Development` or `UAT`, and enter your API origin, for example `https://company-sb.api.identitynow.com`.
4. Enter a SailPoint **personal access token** (client ID and secret), or a short-lived bearer token.
5. Run **Test Authentication** to confirm the connection.
6. To make changes, click the lock icon next to the environment to switch it from read-only to writable.

**Requirements:** VS Code 1.105 or later, a trusted workspace, and an ISC tenant you can reach with a PAT. Node and npm are needed only for building SaaS connector projects.

## Everyday tasks

### Edit a resource

1. Expand a collection in the **Environments** tree and click an item.
2. Edit the JSON and press **Ctrl+S**.
3. If ISC changed in the meantime, use **Compare with Latest ISC** or **Reload from ISC** from the editor toolbar. Nothing is merged or overwritten automatically.

A closed lock means read-only, an open lock means writable. Auto Save never writes to ISC.

### Run any API operation

1. Run **Search All APIs**. It matches method, path, operation ID, category and summary.
2. Choose the operation and the environment. A request file opens with the required parameters filled in.
3. Edit `path`, `query`, `headers` and `body`. Use **Inspect Operation Schema** for scopes, user levels and response schemas.
4. Run **Run Request**. Writes ask for confirmation first.

Supported formats: JSON, JSON Patch, multipart file upload, form URL encoding, and binary downloads. For file fields, use `{"$file": "/path/to/accounts.csv"}`.

### Promote configuration between environments (In Testing)

1. Run **Prepare Environment Promotion**. Choose the source tenant, target tenant, API version and configuration types. Optionally list exact object names.
2. Review `comparison.json` in the folder you chose. Each object is marked `CREATE`, `UNCHANGED` or `REVIEW_UPDATE`.
3. Adjust environment-specific values in `candidate.json`, or add replacements to `mappings.json` and run **Apply Promotion Mappings**.
4. Run **Preview Promotion** and fix any unresolved references.
5. Run **Apply Promotion**. You type the target environment name to confirm, and the import runs with backup enabled.
6. Check `import-result-*.json` and `backup-*.json`. **Resume or Inspect Job** picks up an interrupted job.

Example `mappings.json`:

```json
[
  {
    "pointer": "/objects/0/object/owner/id",
    "from": "source-owner-identity-id",
    "to": "target-owner-identity-id"
  }
]
```

> Promotion is not an automatic rollback. An import can partially succeed, and a backup supports inspection and a separately reviewed restore. Connector passwords and workflow secrets may need manual setup in the target.

### Manage SaaS connectors

Open the **SaaS Connectivity** sidebar to see **Custom Connectors**, **Customizers** and **SaaS Source Instances** for each environment.

- Create, rename, delete, and upload new versions from a ZIP.
- Run **Create Connector Project** or **Create Customizer Project** to scaffold a folder, then **Build Connector Project**.
- Test a deployed connector, or test locally against `127.0.0.1` with **Test Local Connector**.
- Right-click a SaaS source to **Fetch Source Logs** or **Stream Source Logs**. Logs appear in the Output panel.

### Troubleshoot workflows and provisioning

Expand a workflow to see **All Executions** and **Failed Executions**. Expand **Provisioning Activities** under an environment or an identity. Click any record to read it in the Output panel. These are read-only calls and work even when the environment is locked.

## API coverage

| API version | Operations |
| --- | ---: |
| v2026 (default) | 864 |
| v2025 | 814 |
| v2024 | 718 |
| v3 | 358 |
| beta | 561 |

These are versioned entries. Many operations appear in more than one version. Availability still depends on your tenant's features, licensing and permissions. NERM and IdentityIQ are not included.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `iscWorkbench.showApiCatalog` | `false` | Shows the full API catalog in the sidebar. **Search All APIs** works either way. |

## Troubleshooting

| Error | What to check |
| --- | --- |
| **401** | Update your credentials. Pasted bearer tokens must be replaced after they expire. |
| **403** | Check the token's scopes, the owning user's role, and your tenant's feature entitlement. |
| **404** | The endpoint may not be available in your tenant or licence. The extension tries compatible API versions first. |
| **429 / 503** | Reads retry automatically. Writes are never retried, so check the tenant before trying again. |
| **Network failure during a write** | ISC may have accepted it. Inspect the tenant or job before retrying. |
| **Proxy or TLS errors** | VS Code's `http.proxy` setting is not used yet. TLS verification is never disabled. |
| **Tenant actions are disabled** | Open a folder and trust the workspace. Tenant access needs Workspace Trust. |

## Privacy and security

- Credentials are stored in VS Code SecretStorage, not in settings or workspace files.
- The extension talks only to the tenant URLs you configure. It has no telemetry.
- Request logs record method, route, status, duration and request ID, never tokens or bodies.
- Resource and promotion files keep configuration intact so it can be edited faithfully. Store them securely.

See `DATA-HANDLING.md` in the package for the full list of network and storage boundaries.

## Known limitations

- This preview has been tested offline. Testing against a live tenant and on desktop is still in progress, so start with a sandbox environment.
- Local validation is basic. The server is the final authority on whether a request is valid.
- Cloning copies the selected export only. It does not copy password policies, sync groups, connector files or machine subtypes.
- SP-Config has no transaction support, so a very small race exists between the final drift check and the import.

## Release notes

See the **Version History** tab or `changelog.md`.

**0.9.3:** Reload from ISC and Compare with Latest ISC in the editor toolbar, fresh data on reopening an item, readable tab names, and Copy Source Target Name.

## Credits and licence

ISC Workbench is MIT-licensed. Official SailPoint API specifications are redistributed under their MIT licence. Project templates and the reference behaviour come from the MIT-licensed [SailPoint CLI](https://github.com/sailpoint-oss/sailpoint-cli) and [yannick-beot-sp's extensions](https://github.com/yannick-beot-sp/vscode-sailpoint-identitynow). The runtime is independently implemented.

SailPoint and Identity Security Cloud are trademarks of their owners. This extension is not affiliated with or endorsed by SailPoint.

Useful links: [ISC API reference](https://developer.sailpoint.com/docs/api/) · [SP-Config](https://developer.sailpoint.com/docs/api/sp-config/) · [API versioning](https://developer.sailpoint.com/docs/api/api-versioning-strategy/)
