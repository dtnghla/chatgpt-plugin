# Monetization guide

This document describes the built-in monetization layer: a freemium model where every deployment works free of charge with limits, and customers buy a **Pro license key** that removes the limits. The server verifies keys offline with a signing secret; there is no database, no billing dependency and no network call in the license path.

The layer is off by default (`LICENSE_MODE=off`), so self-hosters and the open-source build behave exactly as before. Monetization activates only when you configure it.

## Model: open-core freemium

| | Free | Pro (license key) |
| --- | --- | --- |
| Analyze Pentaho projects | Up to 5 files and 75 workflow steps per project | Unlimited |
| Generate AWS migration bundles | 3 per rolling 24 hours | Unlimited |
| Files readable via `get_migration_file` | Yes | Yes |
| Workbench widget | Yes | Yes |

Free tier limits are env-tunable, so you decide how generous the funnel is. The limits create the conversion incentive on real projects (which are the ones worth paying for) while small projects stay fully usable, which keeps the plugin credible and reviewable.

## How license keys work

A Pro key is a signed token of the form:

```text
PTA1.<base64url payload>.<base64url HMAC-SHA256 signature>
```

The payload records the tier (`pro`), an optional subject (usually the buyer's email), the issue time and an optional expiry. The signature is computed with `LICENSE_SIGNING_SECRET`.

Verification happens inside the server: signature check with a timing-safe compare, then expiry check. There is no license server, so keys keep working offline, and the privacy story is unchanged — the server never phones home about licenses.

Keys can be perpetual or time-limited (`--days`), which supports both one-time purchases and subscriptions.

## Enabling monetization on a deployment

```bash
LICENSE_MODE=enforced
LICENSE_SIGNING_SECRET=<random 16+ chars, e.g. openssl rand -hex 32>
UPGRADE_URL=https://buy.stripe.com/xxxxx          # shown in every upgrade message
FREE_MAX_FILES=5                                   # optional, default 5 (1-50)
FREE_MAX_STEPS=75                                  # optional, default 75
FREE_DAILY_BUNDLES=3                               # optional, default 3; 0 blocks free generation
```

Behavior:

- Free-tier calls that exceed `FREE_MAX_FILES`/`FREE_MAX_STEPS` fail with a message that states the counts, the limits, the `license_key` argument and the `UPGRADE_URL`.
- Free-tier `generate_aws_migration` calls beyond `FREE_DAILY_BUNDLES` in a rolling 24-hour window fail with a quota message. Only successful generations count.
- A call carrying a valid Pro key skips both gates.
- An invalid or expired key produces a "not a valid license" error. Keys passed as tool arguments fail loudly; an invalid `x-pentaho-license-key` header silently falls back to the free tier.
- `UPGRADE_URL` is optional but strongly recommended — it is the conversion path baked into every upgrade message.

Counting note: the bundle quota is kept in the server process. With multiple replicas each process counts separately, so the effective free quota is N per replica. That only ever costs you free-tier generosity, never revenue.

## Minting and verifying keys

Run on a machine that has `LICENSE_SIGNING_SECRET` (your laptop is fine; it does not need to be the server):

```bash
# Perpetual key for one customer
npm run license:generate -- --email alice@example.com

# One-year subscription key
npm run license:generate -- --email alice@example.com --days 365

# Verify a key a customer reports as broken (must use the server's secret)
npm run license:generate -- --verify PTA1.<payload>.<signature>

# Explicit secret instead of the environment variable
npm run license:generate -- --email alice@example.com --secret "$(cat .secret)"
```

The command prints the key; send it to the buyer. Rotating `LICENSE_SIGNING_SECRET` invalidates every previously minted key, so keep a customer list (email → key → expiry) so you can re-mint on rotation. Revoking one customer without rotation is not supported; mint future keys with `--days` (subscriptions) so they expire on their own.

## Selling: checkout and key delivery

The recommended flow uses a **Stripe Payment Link** — no server-side Stripe integration is required:

1. Create a product ("Pentaho to AWS Pro") and a payment link, either one-time or recurring.
2. Set `UPGRADE_URL` to that link. Every free-tier gate message now points buyers at it.
3. Deliver the key after payment:
   - **Manual (start here).** Stripe emails you each sale; run `npm run license:generate -- --email <buyer>` and reply with the key. Fine up to a handful of sales per week.
   - **Automated.** Add a small Stripe webhook handler (`checkout.session.completed`) that mints a key with the same CLI logic and emails it. Use the same `LICENSE_SIGNING_SECRET` value for the webhook and the MCP server: the webhook mints keys, the server verifies them.
4. Keep a ledger mapping email → key → expiry for support, refunds and secret rotation.

Alternatives: Gumroad and Lemon Squeezy handle checkout plus email delivery with less setup and, in Lemon Squeezy's case, merchant-of-record VAT handling. Both still require you to mint the Pro key from the buyer's email. The server does not care where the sale happened — any signed key verifies.

## Pricing guidance

The code supports any price because payment happens outside the server. Reasonable starting points for this kind of migration utility:

- **Perpetual** $49–$99 one-time. Simplest to support; the CLI mints these by default (no `--days`).
- **Annual** $99–$149 per year (`--days 365`). Better if you plan ongoing improvements and support; expire-and-renew matches subscription expectations.
- Consider a free "analysis only" story in your marketing: the free tier already sells the plugin's competence before asking for money.

Pick one, put it on the payment link, and keep `UPGRADE_URL` in sync with what you charge.

## Passing a key to the plugin

Two ways, both supported everywhere:

1. **Tool argument** (works in every host, including ChatGPT): pass `license_key` to `analyze_pentaho_project` or `generate_aws_migration`. In ChatGPT the user can simply paste the key in chat and ask to use it.
2. **Connection header** (cleaner; hosts that support custom headers):

```json
{
  "mcpServers": {
    "pentaho-to-aws": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "x-pentaho-license-key": "PTA1...." }
    }
  }
}
```

Keys are not logged: HTTP logs contain method, path, status and duration only, and tool arguments are never logged.

## Compliance checklist before you sell

- [ ] `docs/submission.md` deployment checklist still holds (`LICENSE_MODE=enforced` added to the production env).
- [ ] `UPGRADE_URL` points at a live checkout page.
- [ ] `TERMS.md` (or your terms page) describes the paid license: what is bought, refund policy, key expiry. Review it with counsel; it is a starting template, not legal advice.
- [ ] `PRIVACY.md` license-key disclosure is accurate (keys are verified locally, never sent to third parties).
- [ ] Keep the secret in your password manager and in the deployment environment; never commit it.

## Honest caveats

- **The repo is MIT.** Anyone can self-host the free build. What you sell is convenience: a hosted endpoint that just works, plus support and updates. That is the standard open-core trade — it works when the hosted path is meaningfully easier than self-hosting.
- **Key security is secret security.** Anyone with `LICENSE_SIGNING_SECRET` can mint unlimited keys. Store it like a production credential.
- **Self-hosters can bypass limits by editing code.** Accept it; they are running their own copy and were never a paying customer.
- If you later want stronger protection or per-usage billing, that means a hosted service with accounts and metering — a different product. The license layer here is deliberately the smallest thing that lets you charge.
