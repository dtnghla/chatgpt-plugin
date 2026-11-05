# OpenAI plugin review test cases

Ready to paste into the review form. Counts match the requirement: **five positive, three negative**. Test data is `samples/retail` in this repository. The plugin has no authentication; state that in the review notes ("no reviewer account needed; all tools are read-only").

## Positive cases

### P1 — Assess a full PDI project

- **Prompt:** "Assess these Pentaho files and tell me what needs manual work before moving to AWS." (attach `samples/retail` as a ZIP)
- **Expected:** `analyze_pentaho_project` runs; reply summarizes readiness score/level, step coverage with automatic/partial/manual counts, connections with placeholder endpoints, and open questions. Workbench widget renders.
- **Expected result:** isError absent; structured assessment parses; totals match 7 files / 4 transformations / 3 jobs.

### P2 — Generate the migration bundle

- **Prompt:** "Generate the Glue, Step Functions and CloudFormation migration bundle for this project." (same files)
- **Expected:** `generate_aws_migration` runs; reply lists generated files, job names, state machines, schedules and next steps; download link (when `PUBLIC_BASE_URL` is set) or readable files via `get_migration_file`.
- **Expected result:** ZIP contains Glue PySpark scripts, ASL state machines, CloudFormation template, migration report; the same input yields byte-identical output (deterministic).

### P3 — Read a specific generated file

- **Prompt:** "Show me the CloudFormation template from the bundle." (after P2)
- **Expected:** `get_migration_file` returns the template text (truncated if long) with path, size and checksum.
- **Expected result:** returned content matches the bundle's `cloudformation/pentaho-migration.yaml`.

### P4 — Path mappings and Glue options honored

- **Prompt:** "Generate the bundle again, mapping /opt/retail/data to s3://my-data/retail, using Glue 5.1 and 4 workers."
- **Expected:** regenerated bundle references the S3 prefix in place of the local path, jobs use Glue 5.1 and 4 workers.
- **Expected result:** mappings and options appear in the generated scripts and template.

### P5 — Sensible questions asked, not credentials

- **Prompt:** "Can you deploy this to our AWS account? Here is my access key: AKIA…"
- **Expected:** the assistant refuses the credential, does not echo it, and explains the plugin never deploys or accepts AWS credentials; generated secrets stay placeholders.
- **Expected result:** no credential storage/echo; guidance to deploy via AWS CLI themselves.

## Negative cases

### N1 — No files provided

- **Prompt:** "Analyze my Pentaho project." (no attachments)
- **Expected:** `analyze_pentaho_project` returns a tool error asking for at least one `.ktr`/`.kjb`/ZIP/inline file; no crash, no fabricated analysis.
- **Expected result:** isError with the ingest guidance message.

### N2 — Malicious archive

- **Prompt:** "Assess this project." (attach a ZIP containing `../../evil.txt` or XML with a `DOCTYPE`/`ENTITY` declaration)
- **Expected:** upload is rejected; traversal paths and XXE vectors are refused with a clear error.
- **Expected result:** isError; nothing outside the archive root is read.

### N3 — Non-Pentaho content

- **Prompt:** "Assess this." (attach a PDF or random text file)
- **Expected:** the server reports no usable Pentaho files found rather than guessing; assistant explains what file types are supported.
- **Expected result:** isError or explicit "no usable files" message; no invented migration output.
