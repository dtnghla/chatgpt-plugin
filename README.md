# Pentaho to AWS

[![CI](https://github.com/dtnghla/chatgpt-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/dtnghla/chatgpt-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A ChatGPT/Codex plugin that assesses Pentaho Data Integration (PDI/Kettle) projects and generates a deployable AWS migration bundle: AWS Glue PySpark jobs, Step Functions state machines, EventBridge Scheduler schedules, Glue JDBC connections with placeholder Secrets Manager secrets, a migration report and one CloudFormation template.

Upload a folder of `.ktr`/`.kjb` files and get a step-by-step conversion map (what converts automatically, what needs a human) plus working Glue scripts and infrastructure — instead of weeks of manual rewrite planning.

The plugin is a read-only MCP server with an MCP Apps workbench. It never contacts AWS, Pentaho Server or your databases, never asks for AWS credentials or passwords, and does not deploy anything. You review the generated bundle and deploy it with the AWS CLI.

## Try it in 60 seconds

No Pentaho project of your own at hand? Use the included [samples/retail](samples/retail) project (synthetic retail warehouse ETL):

1. Run the server:

   ```bash
   npm ci && npm run build && npm start
   ```

2. Connect ChatGPT (Developer mode → Connectors → Create → MCP server, URL `http://127.0.0.1:3000/mcp`) or use the MCP Inspector.
3. Attach the `samples/retail` folder and ask:

   > Assess these Pentaho files and tell me what needs manual work before moving to AWS.

   > Generate the Glue, Step Functions and CloudFormation migration bundle for this project.

You get the readiness report with an interactive workbench, then the migration ZIP with PySpark jobs, state machines, schedules and one CloudFormation template.

## What it does

- Parses `.ktr` transformations, `.kjb` jobs, `kettle.properties`, `shared.xml`, repository exports and project ZIPs.
- Maps every step and job entry to automatic, partial or manual conversion, with caveats per type.
- Scores migration readiness, lists blockers, risks, schedules, parameters and open questions.
- Strips encrypted Pentaho passwords and shows placeholder JDBC endpoints instead.
- Generates Glue 6.0 PySpark scripts (also compatible with Glue 5.1), ASL state machines that use JSONata, EventBridge schedules and a single CloudFormation template.
- Packages everything as a deterministic ZIP plus a machine-readable manifest and a human-readable migration report.

Generated code is advice, not a validated migration. Manual steps, placeholder secrets and semantic differences must be reviewed before use.

## Tools

| Tool | Purpose |
| --- | --- |
| `analyze_pentaho_project` | Parse and assess a project. Returns readiness, step coverage, connections, schedules, dependencies, risks and questions. |
| `generate_aws_migration` | Generate the migration bundle. Accepts Glue version, worker type, worker count, path mappings, step overrides and schedule overrides. |
| `get_migration_file` | Read a generated text file from a bundle by exact path. Bundles expire. |

All three tools are declared read-only and closed-world. The two analysis tools also provide the workbench widget through MCP Apps.

## Quick start

Requires Node.js 22.12 or newer.

```bash
npm ci
npm run build
npm start
```

The MCP endpoint is `http://127.0.0.1:3000/mcp` and the health check is `http://127.0.0.1:3000/healthz`.

Inspect the tools with the MCP Inspector:

```bash
npm run inspect
```

Choose Streamable HTTP and connect to `http://127.0.0.1:3000/mcp`.

## Configuration

Configuration is read from environment variables only; the server does not load `.env` files itself. See [.env.example](.env.example) for a copy-ready template.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. A non-loopback address requires `ALLOWED_HOSTS`. |
| `ALLOWED_HOSTS` | loopback names | Comma-separated hostnames accepted in the `Host` and `Origin` headers of `/mcp`. |
| `FILE_HOST_ALLOWLIST` | `oaiusercontent.com,openai.com` | Hostnames from which uploaded files may be downloaded. HTTPS, port 443, public addresses only. |
| `OPENAI_APPS_CHALLENGE_TOKEN` | unset | Optional token served at `GET /.well-known/openai-apps-challenge`. |
| `WIDGET_DOMAIN` | unset | Optional HTTPS origin advertised to ChatGPT for the MCP Apps widget. |
| `ARTIFACT_STORE` | `memory` | `memory` keeps the 20 newest bundles in-process; `s3` stores them durably. |
| `ARTIFACT_BUCKET` | unset | Required for `ARTIFACT_STORE=s3`. Objects are encrypted with SSE-S3. |
| `AWS_REGION` | `us-east-1` | Region for the S3 artifact backend only. Tools never call other AWS APIs. |
| `ARTIFACT_SIGNING_SECRET` | random per process | Secret used to HMAC-sign artifact download URLs. Set a stable value across replicas. |
| `PUBLIC_BASE_URL` | unset | Public HTTPS origin used in download links. |
| `ARTIFACT_TTL_SECONDS` | `900` | Bundle and link lifetime, 60-86400 seconds. |
| `LICENSE_MODE` | `off` | Monetization: `off` keeps every tool unlimited; `enforced` activates free-tier gates and Pro license keys. |
| `LICENSE_SIGNING_SECRET` | unset | 16+ character secret that verifies minted Pro keys. Required when `LICENSE_MODE=enforced`. |
| `UPGRADE_URL` | unset | Purchase page (e.g. a Stripe payment link) shown in free-tier upgrade messages. |
| `FREE_MAX_FILES` | `5` | Free-tier limit on project files per call (1-50). |
| `FREE_MAX_STEPS` | `75` | Free-tier limit on workflow steps (transformation steps plus job entries) per call. |
| `FREE_DAILY_BUNDLES` | `3` | Free-tier `generate_aws_migration` calls per rolling 24 hours per server process. |

If `PUBLIC_BASE_URL` is not set and the store has no native link support, generated summaries omit the ZIP link and files remain readable through `get_migration_file` until the bundle expires.

## Plugin package

The Agent Plugins 1.0 package lives in [plugins/pentaho-to-aws](plugins/pentaho-to-aws). It contains the manifest, MCP connection, skill instructions and icons. The local marketplace file is [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json).

Point the package at your deployed server:

```bash
npm run plugin:set-url -- https://mcp.example.com/mcp
```

This updates `plugins/pentaho-to-aws/mcp.json` and the skill's `agents/openai.yaml`. Use an HTTPS URL and a path ending in `/mcp`; HTTP is accepted only for loopback development.

Validate the package or check release readiness:

```bash
npm run validate:plugin
npm run validate:plugin:release
```

Release mode additionally requires a public MCP URL and listing links for the website, privacy policy, terms and support. Those are documented in [docs/submission.md](docs/submission.md).

## Monetization

The plugin ships an optional freemium layer. With `LICENSE_MODE=enforced`, projects above the free tier limits and bundle generations beyond the daily quota return a clear upgrade message that includes `UPGRADE_URL`, and a purchased Pro license key (passed as the `license_key` tool argument or the `x-pentaho-license-key` header) removes the limits. Keys are HMAC-signed tokens verified offline — no database, no license service, no network calls in the license path.

Mint keys for customers with:

```bash
LICENSE_SIGNING_SECRET=<the server's secret> npm run license:generate -- --email alice@example.com
LICENSE_SIGNING_SECRET=<the server's secret> npm run license:generate -- --email alice@example.com --days 365
```

The default `LICENSE_MODE=off` keeps the deployment free and unlimited. The full guide — tier design, checkout and key delivery with Stripe payment links, secret rotation, pricing notes — is in [docs/monetization.md](docs/monetization.md).

## Distribution

Shipping this publicly: [docs/launch.md](docs/launch.md) is the launch plan (OpenAI Plugins Directory submission, MCP registries, community channels), [docs/launch-posts.md](docs/launch-posts.md) has ready-to-adapt posts, [docs/review-test-cases.md](docs/review-test-cases.md) has the OpenAI review test cases, and [docs/submission.md](docs/submission.md) covers deployment and validation.

## Docker

```bash
npm run build
docker build -t pentaho-to-aws .
docker run --rm -p 3000:3000 \
  --env-file .env \
  pentaho-to-aws
```

The image binds to `0.0.0.0` by default, so `ALLOWED_HOSTS` is required. Terminate TLS in front of the container.

## Development

```bash
npm run lint          # Biome
npm run typecheck     # TypeScript
npm test              # Vitest, 207 tests
npm run build         # widget + server
npm run check         # lint, typecheck, build, tests, plugin validation
```

Additional verification:

```bash
npm run check:generated   # py_compile and cfn-lint on a generated bundle
npm run smoke:pdi -- /path/to/pdi/samples
```

`check:generated` uses Python and `cfn-lint` when they are available. Set `REQUIRE_GENERATED_CHECKS=1` to fail instead of skipping missing tools. `smoke:pdi` parses and generates from real PDI files without contacting AWS; it is opt-in because the samples are not distributed with this repository.

Tests cover parsing, assessment, deterministic bundle generation, artifact storage and signing, HTTP hardening, the MCP tools and widget resource in both protocol eras, the workbench model and plugin metadata. Golden-file snapshots pin the generated bundle layout.

## Safety and privacy

- No AWS SDK client is created for migration work; generated scripts reference Secrets Manager only when you deploy them. The optional artifact store is the sole AWS caller and only when `ARTIFACT_STORE=s3`.
- No OAuth and no credential prompts. Passwords and encrypted Pentaho passwords are stripped from parsed metadata and every generated artifact.
- Uploaded files are downloaded over HTTPS from allowlisted hosts after DNS resolution rejects private, loopback and reserved addresses. Redirects are revalidated.
- ZIP entries must stay inside the archive root, and XML containing `DOCTYPE` or `ENTITY` declarations is rejected.
- HTTP logs contain only method, path, status and duration. Tool arguments, file names and contents are not logged.
- Inline files are limited to 1 MB each and 5 MB total; combined projects are limited to 50 MB.

See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md).

## Out of scope

Deployment, AWS credentials, OAuth, MWAA/Airflow, Terraform/CDK, Pentaho Server repository browsing, report generation and data reconciliation are intentionally out of scope.

## License

MIT. See [LICENSE](LICENSE).
