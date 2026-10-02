# Publication runbook: Time Zone Planner

This is the checklist and ready-to-paste material for submitting the plugin to the OpenAI plugin directory. Requirements come from OpenAI's documentation (developers.openai.com/plugins/deploy/submission, /app-review, /plugin-guidelines, /submission-errors). Portal labels can change; re-check them against the current docs before submitting.

## 1. Prerequisites

- [ ] Verified developer or business identity in the OpenAI Platform.
- [ ] The Apps Management (`api.apps.write`) permission on your account.
- [ ] A public production HTTPS MCP server URL. Not `localhost`, not a temporary tunnel.
- [ ] Access to set environment variables on the host (for the domain verification token).
- [ ] Public HTTPS URLs for: website, support, privacy policy, terms of use. Use `PRIVACY.md` and `TERMS.md` as drafts; fill in their contact lines first.
- [ ] A demo recording URL.
- [ ] Screenshots (this plugin has custom UI, so they are required; see section 5).
- [ ] `npm run check` passes locally.
- [ ] No demo account is needed: the server has no authentication.

## 2. Listing copy

Source of truth: `plugins/time-zone-planner/plugin.json`. Copy the display name, short description and long description from that file so the portal and the package stay consistent. Do not retype them here.

Limits to respect:

| Field | Limit |
| --- | --- |
| Display name | at most 30 characters |
| Short description | at most 30 characters |
| Starter prompts | at most 3; each at most 128 characters; no `@` mentions |

Also required in the portal: country/region availability, release notes (section 5), and policy attestations.

Reference wording, if you need to rewrite a field (keep it identical to `plugin.json` afterwards):

- Name: Time Zone Planner
- Short description: Meet across time zones (22 characters)
- Long description: Convert a local date and time between IANA time zones, find meeting slots that fit each participant's working hours, and view an hour-by-hour overlap grid. Handles daylight-saving gaps and overlaps. Read-only: it performs calculations only and has no access to calendars or accounts.

## 3. Tool annotations and justifications

The portal asks for each tool's `readOnlyHint`, `openWorldHint` and `destructiveHint`, plus a justification for each. All three tools also set `idempotentHint: true`. The server has no authentication, no database, no user data storage and makes no outbound network calls.

### convert_time

| Annotation | Value | Justification |
| --- | --- | --- |
| `readOnlyHint` | true | Pure computation over the supplied date-time and time zones. It changes no state anywhere. |
| `openWorldHint` | false | It accesses no external services; time zone rules are bundled with the server. |
| `destructiveHint` | false | It cannot modify or delete anything. |

### find_meeting_times

| Annotation | Value | Justification |
| --- | --- | --- |
| `readOnlyHint` | true | Pure computation that ranks candidate slots from the supplied participants and working hours. It does not read or write calendars. |
| `openWorldHint` | false | It uses only the supplied inputs and bundled time zone data; no external services are accessed. |
| `destructiveHint` | false | It only returns suggestions and cannot modify or delete anything. |

### render_meeting_planner

| Annotation | Value | Justification |
| --- | --- | --- |
| `readOnlyHint` | true | Computes a grid and returns it with a widget. Nothing is stored or changed. |
| `openWorldHint` | false | The widget makes no network requests (empty CSP) and the tool accesses no external services. |
| `destructiveHint` | false | It cannot modify or delete anything. The widget only re-calls this same read-only tool to change the displayed date. |

## 4. Test cases

The portal requires exactly five positive and three negative test cases.

### Positive

| # | Prompt | Expected behaviour |
| --- | --- | --- |
| 1 | "What time is 2026-06-15 09:00 in New York in London and Tokyo?" | Calls `convert_time` with `from_time_zone` `America/New_York` and `to_time_zones` `Europe/London`, `Asia/Tokyo`. Reports 14:00 in London (UTC+01:00) and 22:00 in Tokyo (UTC+09:00) on the same date. |
| 2 | "Convert 2026-03-08 02:30 in America/New_York to UTC." | Calls `convert_time`. Explains that 02:30 does not exist on that date (DST gap), says it was moved forward to 03:30 EDT, and gives the UTC result (07:30Z). |
| 3 | "Find a one-hour meeting slot next week for people in New York, London and Berlin, 9 to 5 on weekdays." | Calls `find_meeting_times` with three participants, working hours 09:00 to 17:00 on Monday to Friday, and `duration_minutes` 60. Returns ranked slots where all three are available, with each person's local time. |
| 4 | "Find a 30-minute slot this week for someone in New York and someone in Tokyo, both working 9 to 5 on weekdays." | Calls `find_meeting_times`. The 9-to-5 windows do not overlap, so it states there is no full overlap, shows the best partial slots, and says who is outside working hours in each. It does not claim a full match. |
| 5 | "Show me a planner grid for 2026-09-15 for Los Angeles, London and Singapore." | Calls `render_meeting_planner` with the three participants and `date` `2026-09-15`. The widget renders a 24-hour grid and highlights overlapping working hours (none for this set; the reply should say so). |

### Negative

| # | Prompt | Expected behaviour |
| --- | --- | --- |
| 1 | "Book a meeting with Sam tomorrow at 3pm and send them a calendar invite." | The plugin must not claim it can book or send invites; it has no calendar access. The assistant may offer to compute suitable times, but no tool call should present a booking as done. |
| 2 | "What's the weather in Paris right now, and what's in the news?" | Out of scope. The assistant must not call this plugin's tools for weather, news or stocks. |
| 3 | "Convert 3pm IST to New York time." | "IST" is ambiguous (India, Ireland and Israel standard times). The assistant must ask which time zone is meant before calling a tool, and must not guess. |

## 5. Portal flow

1. **Deploy** the server to a public HTTPS host (see the README, Deploy section). Set `ALLOWED_HOSTS` to the public hostname. Confirm `https://HOST/healthz` returns `{"status":"ok"}`.
2. **Set the plugin URL:**

   ```bash
   npm run plugin:set-url -- https://HOST/mcp
   ```

3. **Fill in the release metadata** in `plugins/time-zone-planner/plugin.json` (website, support, privacy and terms URLs), then run:

   ```bash
   npm run validate:plugin:release
   ```

   This runs the normal schema and OpenAI submission rules and additionally requires a public HTTPS MCP URL and the website, support, privacy and terms URLs. Fix every error before continuing, then commit and push.
4. **Domain verification.** In the OpenAI Platform, start domain verification and copy the token. Set it on the host as `OPENAI_APPS_CHALLENGE_TOKEN` and restart. The server then serves it at `https://HOST/.well-known/openai-apps-challenge` as `text/plain`. Check with `curl https://HOST/.well-known/openai-apps-challenge`, then click "Verify Domain". The token may be hosted on the MCP host or an allowed parent host.
5. **Scan Tools.** Enter the MCP URL and click "Scan Tools". Confirm the three tools appear, then enter the annotation values and justifications from section 3.
6. **Listing.** Enter the name, short description, long description and starter prompts from `plugin.json`, the website, support, privacy policy and terms URLs, and country/region availability.
7. **Screenshots.** Required because the plugin has custom UI. Provide exactly one PNG or JPEG per starter prompt, each exactly 706 px wide and between 400 and 860 px tall. To capture them: run the starter prompt in ChatGPT with the plugin installed, wait for the widget to render, and capture the conversation area; or capture in a browser window sized to 706 px wide and crop the height. Check dimensions before uploading, for example with `file screenshot.png`.
8. **Demo recording.** Record a short screen capture of the starter prompts working end to end, host it at a URL you control, and enter it.
9. **Test cases.** Paste the five positive and three negative cases from section 4.
10. **Release notes.** Use the template below.
11. **Attestations.** Read and confirm each policy attestation yourself; do not tick them on autopilot. The plugin should be able to truthfully attest that it collects no user data, requires no login, and uses no external services.
12. **Submit.** Skills in the package are scanned as part of review, which can take up to 2 hours. Human review time varies and is not guaranteed. Watch the portal and your email for results, and consult the submission-errors page for any rejection reason.

### Release notes template (v1.0.0)

```
Version 1.0.0
Initial release.
- convert_time: convert a local date-time from one time zone to up to 24 others, with UTC offsets, weekday, day shift and daylight-saving gap/overlap handling.
- find_meeting_times: find ranked meeting slots for 1 to 20 participants using their time zones and working hours; falls back to the best partial overlap.
- render_meeting_planner: interactive hour-by-hour overlap grid for one date.
All tools are read-only. No authentication, no data storage.
```

## 6. Updating later

1. Bump `version` in `package.json` and in `plugins/time-zone-planner/plugin.json` together. The validator enforces that they match.
2. Keep tool names and input/output schemas backward compatible. Add optional fields rather than renaming or removing them.
3. For a breaking widget change, serve it under a new resource URI (`ui://time-zone-planner/planner-v2.html`) and point the tool at it, so cached v1 clients keep working.
4. Run `npm run check`, redeploy, run `npm run validate:plugin:release`, then rescan tools in the portal and submit the update with release notes.
5. If tool annotations or behaviour change, update the justifications in section 3 and the portal entries.
