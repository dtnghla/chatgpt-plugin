# Time Zone Planner

Time Zone Planner is a ChatGPT/Codex plugin backed by a remote MCP server. It converts local times between IANA time zones, finds meeting slots that fit each participant's working hours, and renders an hour-by-hour overlap grid as an MCP Apps widget. The server is stateless, needs no authentication or database, and makes no outbound network calls.

The server speaks Streamable HTTP at `/mcp` (MCP TypeScript SDK v2, Express 5) and serves both 2025-era and 2026-07-28 MCP clients.

## What's inside

```
.
├── src/                      MCP server (Express 5, Streamable HTTP) and time-zone logic
├── web/                      MCP Apps widget source (bundled to dist/web/planner.html)
├── plugins/time-zone-planner/
│   ├── plugin.json           Agent Plugins 1.0 manifest
│   ├── mcp.json              MCP server connection for the plugin
│   └── skills/plan-meeting/  Skill (SKILL.md) that guides the model
├── .agents/plugins/marketplace.json   Repo marketplace for local plugin install
├── scripts/                  Plugin validator and server-URL helper
├── test/                     Vitest tests
├── docs/submission.md        OpenAI publication runbook and submission copy
├── Dockerfile                Multi-stage production image
├── PRIVACY.md, TERMS.md      Policy templates (review before publishing)
└── .github/workflows/ci.yml  CI
```

## Quick start

Requires Node.js 22.12 or newer (see `.nvmrc`).

```bash
npm ci
npm run build
npm start
```

The server listens on `http://127.0.0.1:3000`. Smoke test it:

```bash
curl -s http://127.0.0.1:3000/healthz
# {"status":"ok"}

curl -s http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

For development with file watching, use `npm run dev` (builds the widget, then runs the server through `tsx watch`).

## Tools reference

Conventions: time zones are IANA identifiers (for example `America/New_York`; `UTC` is allowed). Local date-times are `YYYY-MM-DDTHH:mm` with no offset. Dates are `YYYY-MM-DD`. Clock times are 24-hour `HH:mm`. Weekdays are ISO numbers 1 (Monday) to 7 (Sunday).

All three tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`, `idempotentHint: true`.

| Tool | Inputs | Output |
| --- | --- | --- |
| `convert_time` | `date_time` (local), `from_time_zone`, `to_time_zones` (1 to 24) | The resolved source moment, the requested date-time, a `dst_adjustment` (`none`, `gap` or `overlap`), the UTC instant, and one entry per target zone with local date-time, UTC offset, weekday, day offset and DST flag. |
| `find_meeting_times` | `participants` (1 to 20; each with `name`, `time_zone`, optional `work_start`, `work_end`, `work_days`), `start_date`, `days` (1 to 14), `duration_minutes` (15 to 480), `step_minutes` (15, 30 or 60), `max_results` (1 to 20) | Ranked slots with per-participant local times and availability, a `has_full_overlap` flag, and a plain-language `summary`. When nobody overlaps fully, the best partial overlaps are returned instead. |
| `render_meeting_planner` | `participants` (1 to 20), `date` (in the first participant's time zone) | The 24-hour grid as structured content plus the interactive widget at `ui://time-zone-planner/planner-v1.html`. The only tool with UI. |

Defaults for working hours are 09:00 to 17:00, Monday to Friday. The first participant is treated as the organizer. A DST gap (a local time that does not exist) is moved forward by the length of the gap; for an overlap (a local time that occurs twice) the earlier occurrence is used. Both cases are reported in `dst_adjustment`.

The widget resource uses MIME type `text/html;profile=mcp-app`, an empty CSP (it makes no network requests) and `prefersBorder: true`.

## Test with MCP Inspector

```bash
npm run build && npm start      # terminal 1
npm run inspect                 # terminal 2
```

In the Inspector, choose the Streamable HTTP transport and enter `http://127.0.0.1:3000/mcp`.

## Connect to ChatGPT in developer mode

1. In ChatGPT, open Settings > Security and login and enable Developer mode.
2. ChatGPT cannot reach `localhost`. Expose the server over HTTPS, either by deploying it (see Deploy) or with a tunnel such as ngrok or Cloudflare Tunnel. Tunnels are fine for developer mode.
3. Start the server with the tunnel hostname allowed, for example:

   ```bash
   HOST=0.0.0.0 ALLOWED_HOSTS=my-tunnel.example.com npm start
   ```

4. Open ChatGPT Plugins, click "+", and enter the HTTPS MCP URL (for example `https://my-tunnel.example.com/mcp`).
5. Choose no authentication and create the connector.

## Install the plugin package locally

The plugin package lives in `plugins/time-zone-planner/`. Its `mcp.json` must point to your server URL. Set it with:

```bash
npm run plugin:set-url -- https://HOST/mcp
npm run validate:plugin
```

ChatGPT desktop: the repository contains `.agents/plugins/marketplace.json`, a repo marketplace. Open the repository, restart the ChatGPT desktop app, and pick the marketplace in the Plugins directory.

Codex CLI:

```bash
codex plugin marketplace add dtnghla/chatgpt-plugin
# or, from a local clone:
codex plugin marketplace add ./
```

## Configuration

The server reads these environment variables. It does not load `.env` files; see `.env.example`.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Listening port. |
| `HOST` | `127.0.0.1` | Bind address. |
| `ALLOWED_HOSTS` | none | Comma-separated hostnames (no scheme, any port) accepted in the `Host` header. Required when `HOST` is not a loopback address; the server refuses to start otherwise. |
| `OPENAI_APPS_CHALLENGE_TOKEN` | unset | When set, served as `text/plain` at `GET /.well-known/openai-apps-challenge` for OpenAI domain verification. |

Routes:

| Route | Purpose |
| --- | --- |
| `POST`, `GET`, `DELETE /mcp` | MCP endpoint (Streamable HTTP, stateless). |
| `GET /healthz` | Returns `200` with `{"status":"ok"}`. Not subject to Host validation. |
| `GET /.well-known/openai-apps-challenge` | Domain verification token, when configured. |

## Deploy

Build and run the container:

```bash
docker build -t time-zone-planner .
docker run --rm -p 3000:3000 \
  -e ALLOWED_HOSTS=mcp.example.com \
  time-zone-planner
```

The image sets `HOST=0.0.0.0` and `PORT=3000`, runs as the non-root `node` user, and ships only `dist/` and production dependencies. Because `HOST` is not loopback, the container exits at startup unless `ALLOWED_HOSTS` is set. Add `-e OPENAI_APPS_CHALLENGE_TOKEN=...` when verifying the domain with OpenAI.

Any host that provides HTTPS in front of a container or Node process works. Point the platform health check at `GET /healthz`. The image also defines a Docker `HEALTHCHECK` against it.

After deploying, update the plugin package with the public URL:

```bash
npm run plugin:set-url -- https://mcp.example.com/mcp
```

## Publishing checklist

The full runbook, listing copy, tool annotation justifications and test cases are in [docs/submission.md](docs/submission.md). Short version:

- Deploy to a public HTTPS URL and run `npm run plugin:set-url -- https://HOST/mcp`.
- Run `npm run validate:plugin:release`.
- Host `PRIVACY.md` and `TERMS.md` content at public HTTPS URLs and fill in the contact details.
- Verify the domain, scan tools, and complete the submission in the OpenAI Platform.

## Development

| Script | Purpose |
| --- | --- |
| `npm run build` | `build:web` (widget to `dist/web/planner.html`) then `build:server` (to `dist/src/*.js`). |
| `npm start` | `node dist/src/main.js`. |
| `npm run dev` | Build the widget, then run `tsx watch src/main.ts`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `biome check .`. |
| `npm run format` | `biome check --write .`. |
| `npm test` | `vitest run`. |
| `npm run validate:plugin` | Validate the plugin package against the schema and OpenAI submission rules. |
| `npm run validate:plugin:release` | As above, and additionally require a public HTTPS MCP URL and website, support, privacy and terms URLs. |
| `npm run plugin:set-url -- https://HOST/mcp` | Write the MCP server URL into the plugin package. |
| `npm run inspect` | Run `npx @modelcontextprotocol/inspector`. |
| `npm run check` | Lint, typecheck, build, test and validate the plugin (what CI runs). |

Layout: `src/time` holds the pure time-zone logic, `src` the MCP server and tool registration, `web` the widget, `plugins/time-zone-planner` the plugin package, `scripts` the validator and URL helper, and `test` the Vitest suites.

The time logic is pure functions over IANA zones (using `temporal-polyfill`) with no I/O, tested directly in `test/` with fixed dates, including DST gaps and overlaps, overnight shifts and zones with unusual offsets.

MCP SDK v2 note: the server creates a new MCP server instance per request and keeps no sessions, so any instance can handle any request. Server logs do not include tool arguments.

## Troubleshooting

- **403 from the server (Host validation):** the request's `Host` header is not allowed. Set `ALLOWED_HOSTS` to the public hostname (no scheme, no port). `/healthz` is exempt.
- **Server exits at startup:** `HOST` is not a loopback address and `ALLOWED_HOSTS` is empty. Set `ALLOWED_HOSTS`.
- **Tool list not showing in ChatGPT:** re-scan or refresh the connector after changing tools or the server URL.
- **Widget not rendering:** check that the UI resource is served with MIME type `text/html;profile=mcp-app` and that `dist/web/planner.html` exists. Run `npm run build`.
- **ChatGPT cannot reach the server:** `localhost` and `127.0.0.1` are not reachable from ChatGPT. Use a tunnel or a deployed HTTPS URL.

## License

MIT. See [LICENSE](LICENSE).
