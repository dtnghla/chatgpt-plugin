# Sample project: retail warehouse ETL

A small, realistic Pentaho Data Integration project you can use to try the plugin without your own `.ktr`/`.kjb` files. Everything here is synthetic and MIT-licensed.

## What it models

A nightly retail warehouse load:

- `transforms/orders.ktr` — reads order CSVs, aggregates by country, writes to a warehouse table.
- `transforms/customers.ktr` — loads customer master data, normalizes fields, deduplicates.
- `transforms/exports.ktr` — extracts export rows for downstream systems.
- `jobs/nightly.kjb` — the nightly orchestration: runs the child job, sends a notification.
- `jobs/child.kjb` — a nested job with its own entries.
- `kettle.properties` — shared variables such as `${DB_HOST}` and paths.
- `repository-export.xml` — a PDI repository export containing the same objects.

Connections use variables and one encrypted password, exactly like a real project, so the assessment shows what a real migration report looks like: placeholder JDBC endpoints, Secrets Manager placeholders, a readiness score, step-by-step conversion mapping and open questions.

## Try it

1. Start the server (`npm ci && npm run build && npm start`) or connect to a hosted instance.
2. Attach this folder (or a ZIP of it) in ChatGPT and ask:
   > Assess these Pentaho files and tell me what needs manual work before moving to AWS.
3. Then ask:
   > Generate the Glue, Step Functions and CloudFormation migration bundle for this project.
