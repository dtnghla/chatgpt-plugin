# Submission guide

This document describes how to deploy and submit the Pentaho to AWS plugin. It is written for the repository owner. The plugin never touches an AWS account; it only generates artifacts that the user deploys.

## Package layout

```text
plugins/pentaho-to-aws/
  plugin.json                  Agent Plugins 1.0 listing
  mcp.json                     Streamable HTTP connection
  assets/logo.svg              512x512 listing logo
  assets/composer-icon.svg     Square composer icon
  skills/migrate-pentaho/SKILL.md
  skills/migrate-pentaho/agents/openai.yaml
.agents/plugins/marketplace.json   Local development marketplace
```

`npm run validate:plugin` validates the package against the bundled Agent Plugins schemas plus the repository's listing, icon, skill and security checks.

## 1. Deploy the MCP server

Build and run the image behind a TLS-terminating proxy:

```bash
npm run build
docker build -t pentaho-to-aws .
docker run -d --name pentaho-to-aws -p 3000:3000 --env-file .env pentaho-to-aws
```

Production environment checklist:

- `HOST=0.0.0.0` inside the container.
- `ALLOWED_HOSTS=mcp.example.com` with your public hostname. The server refuses to start on a public bind without it.
- `PUBLIC_BASE_URL=https://mcp.example.com` so generated ZIP links point at the public origin.
- `ARTIFACT_SIGNING_SECRET` set to a stable random value, not the startup default.
- `ARTIFACT_STORE=s3` and `ARTIFACT_BUCKET=...` for durable bundles across restarts and replicas, plus an S3 lifecycle rule for physical deletion.
- `AWS_REGION` set for the artifact bucket. The S3 backend uses the task role's default credential chain.
- `FILE_HOST_ALLOWLIST` includes the host domain that delivers ChatGPT uploads (`oaiusercontent.com` and `openai.com` by default).
- `ARTIFACT_TTL_SECONDS` left at 900 unless you need longer review windows.
- `WIDGET_DOMAIN` only if OpenAI requires a dedicated widget origin.
- `OPENAI_APPS_CHALLENGE_TOKEN` set temporarily for domain verification.

Verify the deployment:

```bash
curl -fsS https://mcp.example.com/healthz
```

```json
{"status":"ok"}
```

Then connect the MCP Inspector to `https://mcp.example.com/mcp` and call each tool with the files under `test/fixtures/retail` (upload the folder or use `inline_files` from the fixture contents).

## 2. Point the package at the deployment

```bash
npm run plugin:set-url -- https://mcp.example.com/mcp
```

The command updates `plugins/pentaho-to-aws/mcp.json` and `plugins/pentaho-to-aws/skills/migrate-pentaho/agents/openai.yaml`. It rejects non-HTTPS public URLs, credentials, query strings, fragments and paths that do not end in `/mcp`. Loopback HTTP is accepted only for local testing.

Confirm that both files contain the same URL, then run:

```bash
npm run check
npm run validate:plugin:release
```

Release mode requires the configured MCP URL to be public HTTPS and the listing URLs in `plugin.json` to resolve to real pages. It also rejects placeholder or private hosts.

## 3. Listing fields

| Field | Value |
| --- | --- |
| Name | `pentaho-to-aws` |
| Display name | Pentaho to AWS |
| Category | Data & Analytics |
| Website | Repository or product page |
| Privacy policy | `https://github.com/dtnghla/chatgpt-plugin/blob/main/PRIVACY.md` |
| Terms of service | `https://github.com/dtnghla/chatgpt-plugin/blob/main/TERMS.md` |
| Support | `https://github.com/dtnghla/chatgpt-plugin/issues` |
| Logo | `plugins/pentaho-to-aws/assets/logo.svg` |
| Composer icon | `plugins/pentaho-to-aws/assets/composer-icon.svg` |

The plugin description and starter prompts are in `plugin.json`. Keep the safety statements accurate: read-only, no AWS credentials, no deployment, passwords stripped.

Screenshots are optional and only used for custom UI plugins. If added, each starter prompt needs one 706px-wide PNG or JPEG, 400-860px tall, and the package validator warns rather than fails on dimension mismatches.

## 4. Security review answers

Be ready to answer these points:

- **AWS access.** Tools never create an AWS client. The generated bundle is reviewed and deployed by the user; the server holds no deployment credentials.
- **Credentials.** The server rejects AWS keys, session tokens and passwords in prompts and inputs. It strips encrypted Pentaho passwords and password-like properties, and generated secrets are placeholders.
- **Uploads.** Files are downloaded only over HTTPS on port 443 from `FILE_HOST_ALLOWLIST` hosts after DNS rejects private, loopback and reserved addresses. Redirects are revalidated. ZIP traversal and XML `DOCTYPE`/`ENTITY` declarations are rejected.
- **Limits.** 25 MB per download, 500 archive entries, 10 MB per uncompressed file, 50 MB per project, 1 MB per inline file and 5 MB inline total.
- **Logging.** One line per request with method, path, status and duration. No arguments, bodies, file names or contents.
- **Artifacts.** Memory by default; optional S3 with SSE-S3. Links are HMAC-signed and expire. Expired metadata is rejected; operators add lifecycle rules for physical deletion.
- **Read-only tools.** Every tool declares `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Data handling.** No telemetry or third-party APIs. See `PRIVACY.md`.

## 5. Verification before submission

```bash
npm ci
npm run check
npm run validate:plugin:release
npm run check:generated
```

Optional, with real PDI samples:

```bash
npm run smoke:pdi -- /path/to/pdi/samples
```

Manual checks:

1. Open the workbench widget after `analyze_pentaho_project`; it should show readiness, step coverage, risks and the project flow graphs.
2. Generate a bundle and confirm the ZIP link downloads a readable archive, or read `README.md` through `get_migration_file` when no link is configured.
3. Confirm an invalid bundle id, an unknown path and a traversal path return tool errors without leaking files.
4. Confirm the challenge endpoint returns the configured token only when `OPENAI_APPS_CHALLENGE_TOKEN` is set.
5. Deploy the generated fixture bundle to a scratch AWS account with the README commands and verify the stack and one Step Functions execution. This step is manual and outside the plugin's automation.

## Known limitations to disclose

- Generated Glue scripts assume source data is reachable from S3; local PDI paths are mapped or written under `s3://<DataBucket>/unmapped/`.
- Job graphs are linearized into Step Functions; parallel branches with shared state are not reproduced.
- PDI schedules have no stored time zone; generated EventBridge schedules run in UTC unless overridden.
- Excel, GetVariable and several job entries are partial mappings and need review.
- Shell, plugin and unknown steps are emitted as manual stubs.
- Repository browsing, report generation, deployment and data reconciliation are out of scope.

## Rollback

The plugin has no server-side state outside the artifact store. To roll back, redeploy the previous image and keep the same signing secret if you need old links to keep working. Delete the S3 artifact prefix or let the lifecycle rule expire it.
