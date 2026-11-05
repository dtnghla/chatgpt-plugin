# Launch plan: getting real users

This is the owner's playbook for turning the repo into a used product. It separates what you can do in an afternoon from what compounds over weeks. Nothing here requires changing the plugin's behavior.

## Who the user is

Teams running production Pentaho Data Integration jobs who are moving (or being forced) to AWS: Hitachi's Pentaho licensing and support posture pushes mid-size companies to re-platform, and their pain is not "write Spark" — it is "I have 200 transformations and need to know what breaks." The plugin answers exactly that question, for free, in minutes.

The first real users therefore look like: a data engineer googling "pentaho to aws migration", "convert ktr to glue", or asking an LLM the same question. Distribution = being present where those searches and questions happen.

## Phase 0 — make the repo submittable (half a day, all local)

1. **Commit and push.** The monetization layer and launch assets are currently uncommitted on `cursor/pentaho-aws-migrator-1d84`. Merge to `main` so the CI badge is green and GitHub renders the finished README.
2. **Deploy one public HTTPS MCP endpoint.** Required for the OpenAI directory and for hosted trial by non-technical users. The researched winner (Nov 2026) is **Fly.io** in Singapore (~$3.69/mo, 512 MB, `shared-cpu-1x`): it deploys the existing Docker image, imposes no proxy request timeout on SSE streams, includes free TLS, and can pin one always-on machine. Note Fly's default auto-stop pauses idle machines — the committed [fly.toml](../fly.toml) sets `auto_stop_machines = false` and `min_machines_running = 1` to protect the in-memory artifact store. Zero-cost fallback with no card required: **Northflank Developer Sandbox** (always-on, 2 services). Disqualified for this app: AWS App Runner (120 s request timeout kills MCP SSE), DigitalOcean App Platform (proxy buffers SSE), Render/Koyeb free tiers (sleep → state loss), Oracle Always Free (idle reclamation), Zeabur (shutting down 2026-12-31). Setup:

   ```bash
   fly launch --no-deploy                      # create the app; update app name + ALLOWED_HOSTS in fly.toml
   fly secrets set ARTIFACT_SIGNING_SECRET=$(openssl rand -hex 32)
   fly secrets set PUBLIC_BASE_URL=https://pentaho-to-aws.fly.dev ALLOWED_HOSTS=pentaho-to-aws.fly.dev
   fly deploy
   curl -fsS https://pentaho-to-aws.fly.dev/healthz
   ```

   Leave `LICENSE_MODE=off` at launch — the free hosted tier is the growth engine; flip on monetization later per [monetization.md](monetization.md).
3. **Smoke-test the public endpoint** with `samples/retail` end to end (analyze → generate → download ZIP).

## Phase 1 — the OpenAI Plugins Directory (the big shelf)

ChatGPT and Codex share one plugin directory; submission goes through <https://platform.openai.com/plugins>. Full deployment details are in [submission.md](submission.md); the review-specific items:

- Verify a developer/business identity in org settings and grant yourself **Apps Management: Write**.
- Upload the plugin ZIP (`npm run plugin:pack` builds `dist/pentaho-to-aws-plugin.zip` from `plugins/pentaho-to-aws`; point `mcp.json` at your public URL first with `npm run plugin:set-url -- https://<your-domain>/mcp`).
- Domain verification: set `OPENAI_APPS_CHALLENGE_TOKEN` on the server with the token OpenAI shows you.
- Supply the **review test cases** — ready-made in [review-test-cases.md](review-test-cases.md) (5 positive, 3 negative, matching the required counts).
- Record the **video walkthrough** — script below.
- Reviewer credentials: not needed — the plugin has no auth, which reviewers like; state that explicitly in the review notes.
- Listing identity must match your public URLs (github.com/dtnghla). Keep name/support/privacy URLs consistent.

## Phase 2 — MCP registries and directories (an afternoon)

- **Official MCP Registry** — free, canonical; register the server URL.
- **Glama** (<https://glama.ai/mcp/servers>) — indexes public GitHub repos automatically once pushed; claim the page.
- **Smithery** (<https://smithery.ai>) — create an account, connect the repo, let it scan the server.
- **mcp.so** — direct submit form at <https://mcp.so/submit>.
- **PulseMCP** — submissions were paused recently; retry periodically.
- Later lever: publish an npm package so `npx`-style installs work and directory indexing gets easier. Requires exposing a stdio transport, which is a code change — not needed for the directory launches above.

## Phase 3 — communities where the users already are (ongoing, 1 post per week)

Post where Pentaho and AWS-migration people already hang out. Rules: lead with the free assessment (not the code), include one screenshot of the workbench report, answer every reply, never cross-post the same week.

| Channel | Angle |
| --- | --- |
| Hacker News (Show HN) | "Show HN: I built a ChatGPT plugin that converts Pentaho ETL jobs to AWS Glue" — launch weekdays Tue–Thu, mornings ET |
| r/dataengineering | "I kept meeting teams stuck on Pentaho migrations, so I built a free assessment tool" |
| Hitachi Vantara Pentaho community forums | The single most concentrated audience; position as a migration-planning aid, be explicit that output needs review |
| LinkedIn | Before/after story: 200 PDI steps → readiness score + Glue scripts; tag it as open source |
| X/Twitter | Short demo GIF thread; MCP/ChatGPT-plugin audiences amplify these |

Draft copy for each is in [launch-posts.md](launch-posts.md).

## Phase 4 — measure and iterate

Watch, weekly: GitHub stars/traffic (clones tell you real interest), directory impressions, issues/questions arriving from new usernames, and server logs for `/mcp` tool-call volume (method+path only, no content). If analyze calls are high but generate calls are low, the assessment is resonating and generation friction needs copy work; if nothing arrives from a channel, stop posting there.

The free hosted tier is the funnel. Introduce `LICENSE_MODE=enforced` only after real usage exists — see the caveats section of [monetization.md](monetization.md).

## Video walkthrough script (~3 minutes, doubles as the OpenAI review video)

1. (0:00) The problem: a folder of `.ktr`/`.kjb` files and a migration deadline.
2. (0:20) Upload `samples/retail` in ChatGPT, ask for the assessment; scroll the readiness report and step coverage in the workbench widget.
3. (1:10) Ask for the bundle; open the ZIP: Glue scripts, state machine JSON, CloudFormation, migration report.
4. (1:50) Point out placeholders (`<DataBucket>`, Secrets Manager names) and one manual stub — honesty is the differentiator.
5. (2:20) `aws cloudformation deploy` on a scratch account; show one Step Functions execution running.
6. (2:45) Safety recap: read-only, no credentials, no deployment. Repo URL on screen.

## First 100 users checklist

- [ ] Branch merged to `main`, pushed, CI green
- [ ] Public HTTPS endpoint live and smoke-tested with `samples/retail`
- [ ] OpenAI Plugins Directory submission sent (test cases + video included)
- [ ] Listed on official MCP Registry, Glama claimed, Smithery connected, mcp.so submitted
- [ ] Show HN posted
- [ ] r/dataengineering post + Pentaho forum thread answered within 24h of posting
- [ ] LinkedIn + X demo posted
- [ ] Weekly metrics review scheduled
