# Terms of service

Last updated: 2026-10-31

These terms apply to the Pentaho to AWS plugin and MCP server in this repository. By using the software you agree to them. If you self-host the server, you are responsible for the deployment and for any terms you present to your own users.

## What the service does

Pentaho to AWS parses Pentaho Data Integration projects that you provide and generates a migration bundle containing AWS Glue PySpark scripts, Step Functions definitions, EventBridge Scheduler schedules, Glue connection definitions, placeholder Secrets Manager secrets and a CloudFormation template.

The software is read-only. It does not deploy, does not call AWS deployment APIs, does not connect to your databases, and does not store or print AWS credentials or database passwords.

## Generated output is advice

Generated code is a best-effort translation, not a validated migration. It may contain manual stubs, partial mappings, placeholder endpoints and differences in partitioning, transaction boundaries, error handling and scheduling semantics. You must review, test and adapt every artifact before using it. You are responsible for any AWS resources you create with the generated CloudFormation template and for their cost, security and compliance.

## Acceptable use

Do not use the software to process data you are not authorized to process, to attack or probe systems, to bypass access controls, or to generate content that violates applicable law. Do not rely on it as the sole control for regulated data, security decisions or production deployment.

## Availability

The repository is provided as open source without an SLA. Self-hosted deployments may be unavailable or lose in-memory bundles on restart. Bundles expire; regenerate them when needed.

## No warranty

The software and generated output are provided "as is", without warranty of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose and non-infringement. The authors are not liable for any claim, damages or other liability arising from the software or its output, to the maximum extent permitted by law.

## Privacy

See [PRIVACY.md](PRIVACY.md) for what the software processes and its logging and retention behavior.

## Changes

These terms may be updated in this repository. The current version applies to the current release. Continued use after a change constitutes acceptance.

## Contact

Open an issue at <https://github.com/dtnghla/chatgpt-plugin/issues> for questions about these terms.

## License

The software is licensed under the MIT License. See [LICENSE](LICENSE). These terms do not replace the license; in case of conflict about the software itself, the license controls.
