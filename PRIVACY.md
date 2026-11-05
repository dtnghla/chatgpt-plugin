# Privacy policy

Last updated: 2026-11-05

Pentaho to AWS is a self-hosted MCP server and ChatGPT/Codex plugin. It analyzes Pentaho Data Integration files that the user supplies and generates AWS migration artifacts. This policy describes what the software processes when you run or use it.

## Data the plugin processes

- **Uploaded project files.** The host passes either HTTPS download references or inline file content for `.ktr`, `.kjb`, XML, properties and ZIP files. The server reads them only to parse the project and generate a migration bundle.
- **Project parameters and connection metadata.** Hostnames, ports, database names, usernames and parameter names are used to describe the migration. Encrypted Pentaho passwords and password-like properties are stripped and never included in output.
- **Generated artifacts.** Glue scripts, Step Functions definitions, schedules, a CloudFormation template, a migration report, a README and a manifest are held in the configured artifact store until they expire.

The plugin does not require an account, does not use OAuth, and does not ask for AWS credentials, access keys, session tokens or database passwords.

- **Optional license keys.** A deployment may enforce free-tier limits that a purchased Pro license key removes. When you pass a key (as a tool argument or a connection header), the server verifies its cryptographic signature locally and checks its expiry in memory. Keys are not logged, not stored persistently, and never sent to any third party or license service. See [docs/monetization.md](docs/monetization.md).

## Logging

The server writes one line per HTTP request containing the method, path, status code and duration. It does not log request bodies, tool arguments, uploaded file names, file contents, query strings or secrets. Error logs contain an error message but not the input that caused it.

The operator of a self-hosted deployment may add infrastructure logging. Such logging is outside this software's control and should be configured not to capture request bodies.

## Artifacts and retention

- The default `memory` backend keeps the 20 newest bundles in process memory. They are lost on restart and expire after `ARTIFACT_TTL_SECONDS` (900 seconds by default).
- The optional `s3` backend writes each bundle as a ZIP and a JSON metadata object to the operator's bucket, encrypted with SSE-S3. Expired metadata is rejected by the server, but S3 objects are not deleted automatically. Operators should add an S3 lifecycle rule if physical deletion is required.
- Download links are HMAC-signed and expire with the bundle. The signing secret is held in server memory from `ARTIFACT_SIGNING_SECRET`.
- Generated artifacts may contain business schema names, SQL and file paths from the uploaded project. Treat the artifact store and its bucket as confidential.

## Third parties

The software has no telemetry, analytics, advertising or third-party APIs. It does not send project data to AWS, OpenAI or any other service. When used through ChatGPT or Codex, the host platform's own privacy terms govern how the conversation and uploaded files are handled before they reach this server. Inline analysis runs locally to the server; the optional S3 artifact store is the only AWS service this software contacts, and only when the operator enables it.

The server downloads upload references only from hosts in `FILE_HOST_ALLOWLIST`, over HTTPS, after rejecting private, loopback and reserved IP addresses.

## Security

Inputs are treated as untrusted: ZIP traversal is rejected, XML `DOCTYPE` and `ENTITY` declarations are rejected, project size limits apply, and generated text is returned as data rather than executed. The server does not deploy anything and holds no AWS deployment credentials. See the README for the full safety model.

## Your choices

- Do not upload projects you are not authorized to process.
- Remove or redact sensitive connection details before sharing a project if your policy requires it.
- Use `ARTIFACT_STORE=memory` when you do not want generated artifacts written to disk or S3.
- Shorten `ARTIFACT_TTL_SECONDS` to reduce the window in which bundles remain retrievable.

## Contact

For privacy questions or deletion requests concerning a self-hosted deployment, contact the operator of that deployment. For questions about this repository, open an issue at <https://github.com/dtnghla/chatgpt-plugin/issues>.
