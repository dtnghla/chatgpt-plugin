# Launch posts (copy, adapt, post)

Honest, channel-appropriate drafts. Personalize the first line; posts that read like a template get ignored. One channel per week works better than a same-day cross-post blast. Replace `<your-domain>` with the live endpoint and `<repo>` with `https://github.com/dtnghla/chatgpt-plugin`.

## Show HN

**Title:** Show HN: ChatGPT plugin that converts Pentaho Data Integration jobs to AWS Glue

**Body:**

I've watched a few Pentaho-to-AWS migrations stall at the planning stage: hundreds of `.ktr`/`.kjb` files, nobody sure what a step even does anymore, and consultants quoting months just to produce a conversion inventory.

So I built a ChatGPT/Codex plugin (MCP server) that does the first mile:

- Upload PDI files (or a ZIP / repository export) → it maps every step and job entry to automatic / partial / manual conversion, with per-type caveats
- Scores migration readiness and lists blockers, schedules, connections and open questions
- Generates a deployable bundle: Glue PySpark jobs, Step Functions state machines (JSONata), EventBridge schedules, Glue JDBC connections with Secrets Manager placeholders, and one CloudFormation template

It's read-only: no AWS calls, no credentials, passwords stripped from parsed metadata. You deploy the ZIP yourself with the AWS CLI. Generated code is explicitly advice, not a validated migration — the report marks the manual stubs rather than pretending.

Try it without your own files using the sample project in `samples/retail` (`<repo>`). Self-host with Node or Docker; the README has a 60-second path.

Stack: TypeScript MCP server, ~240 tests, golden-file pinned output. What would make this actually useful in a migration you've lived through?

## r/dataengineering

**Title:** Free tool: paste your Pentaho .ktr/.kjb files into ChatGPT, get a step-by-step AWS migration map + Glue/Step Functions starter bundle

**Body:**

I built an open-source ChatGPT plugin for teams stuck on Pentaho Data Integration who need to move to AWS. The annoying part of these projects was never writing Spark — it was producing a trustworthy inventory: which of the 150 transformations convert cleanly, which need rework, which schedules and connections exist at all.

The plugin (an MCP server you can self-host or connect from any MCP client):

- Reads `.ktr`, `.kjb`, `kettle.properties`, `shared.xml`, repository exports, ZIPs
- Maps every step/job entry to automatic / partial / manual with caveats
- Emits Glue PySpark scripts, Step Functions state machines, EventBridge schedules, a CloudFormation template and a migration report as a ZIP

Read-only, strips passwords, never touches AWS. Sample project included so you can see the report before digging up your own files: `samples/retail` in the repo. MIT, feedback welcome — especially "this step type is everywhere in our estate and maps badly" replies. `<repo>`

## Hitachi Vantara Pentaho community forum

**Title:** Open-source migration planner: readiness assessment + AWS Glue bundle from PDI files

**Body:**

I'd like to share an open-source planning aid for teams evaluating a move off PDI: `<repo>`. You give it your transformations and jobs (files or a repository export); it returns a per-step conversion map (automatic / partial / manual with reasons), a readiness score, and optionally generates a starting AWS bundle (Glue PySpark, Step Functions, EventBridge schedules, CloudFormation).

It is deliberately conservative: generated code is a starting point for engineers, not a finished migration, and the report calls out every step it couldn't convert cleanly. It runs as a read-only service — no AWS access, credentials stripped from analysis.

It integrates with ChatGPT/Codex as a plugin, or you can self-host the MCP server. If you try it against a real project, I'd genuinely value a comment on which step types mapped worst.

## LinkedIn

**Title:** Pentaho → AWS migrations fail in week 1: nobody knows what's inside the jobs.

**Body:**

Most Pentaho-to-AWS projects I've seen stall before a line of Spark is written — in the inventory phase. 150 transformations, 40 job entries, ten years of tribal knowledge.

So I built an open-source ChatGPT plugin that does the inventory in minutes: upload `.ktr`/`.kjb` files, get a per-step conversion map (automatic / partial / manual), a readiness score, and a starting bundle of Glue jobs, Step Functions state machines and CloudFormation.

Read-only, no credentials, passwords stripped. Open source (MIT): `<repo>`

If your team is mid-migration: what's the step type that hurts most? Building the map is the easy part — knowing it's right is the product.

## X / Twitter

**Thread starter:**

Pentaho ETL → AWS, but the hard part is the inventory, not the Spark.

I built a ChatGPT plugin that reads .ktr/.kjb files and returns:
- per-step conversion map (auto/partial/manual)
- readiness score + risks
- Glue jobs, Step Functions, CloudFormation as a deployable ZIP

Read-only. Open source. 🧵

**Follow-ups:**

1/ Here's the readiness report for the sample project — every step classified, blockers called out, passwords stripped automatically. [screenshot]

2/ And the generated bundle: Glue PySpark + Step Functions (JSONata) + EventBridge schedules + one CloudFormation template. You deploy it, it never touches your AWS account. [screenshot]

3/ MIT + self-hostable (Node/Docker). Sample project included: `<repo>`
