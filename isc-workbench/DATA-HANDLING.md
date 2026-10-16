# Data handling — 0.9.1

This is a source-code review summary, not a penetration-test certificate or client security approval.

## Network destinations

- ISC requests and OAuth credentials go over HTTPS to the configured SailPoint API origin. The client refuses redirects and credential-header overrides. There is no extension telemetry, analytics SDK, AI service integration, or upload to the extension author/OpenAI.
- Promotion explicitly transfers selected configuration to the chosen target tenant. Uploaded connector code and invoked connector commands may interact with the connected third-party system through SailPoint.
- Local connector testing explicitly sends the selected test input/configuration to `127.0.0.1` at the selected port. It does not send ISC Authorization headers and does not follow redirects. The local server is separate code and could itself communicate elsewhere.
- Build/debug tasks execute approved project scripts. npm and project dependencies have their own network access and security characteristics; they are not sandboxed by this extension.
- Open Documentation opens a public SailPoint page in the browser, using an API operation name, without attaching tenant payloads or credentials.

## Stored and displayed data

- Credentials and saved creation drafts use VS Code SecretStorage. Version 0.9.1 migrates legacy `isc.drafts` state into SecretStorage and clears that state only after a successful store. This does not securely erase remnants in old database pages, OS backups or older exported archives.
- Environment metadata, connector-type cache and recent promotion job identifiers remain in ordinary VS Code extension state. Runtime caches, test replay and Output content are memory based from the extension's perspective.
- Exported JSON, downloaded reports and promotion bundles/backups are files written to locations selected by the user. The extension does not encrypt those files. File locations may be synced or backed up by other software.
- JSON editors and Output display client data. Redaction is best effort; logs/errors can contain personal or sensitive data. VS Code recovery/history, other installed extensions, clipboard tools and endpoint software have their own behavior, which this extension cannot guarantee.
- Auto Save is blocked from submitting connected documents to ISC. Explicit saves, creation actions, connector invocations and other authorized commands can write to the selected tenant.

## Client use

Use client-approved tenants, credentials/scopes, extensions and storage locations. Review connector code and project dependencies before running them. Public release still requires live desktop acceptance, dependency/package review and the client's security approval. No live network-capture audit or independent security assessment was performed for this release.

VS Code storage reference: https://code.visualstudio.com/api/extension-capabilities/common-capabilities
