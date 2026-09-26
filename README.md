# @pipeworx/mhra-alerts

UK medicines and medical device **safety alerts, recalls and safety-signal bulletins** published by the MHRA on GOV.UK. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

Companion to `@pipeworx/mhra-uk`, which covers MHRA *product* documents (SmPC, PIL, PAR) — what a licensed medicine is and what its label says. This pack covers what went wrong with one: batch recalls, field safety notices, device safety information and prescriber safety advice.

## Tools

- `mhra_safety_alerts(query?, alert_type?, issued_from?, issued_to?, specialism?, sort?, limit?, offset?)` — search MHRA drug and device safety alerts. Returns title, alert category, issue date, summary and GOV.UK URL.
- `mhra_alert_detail(url)` — full text of one alert or Drug Safety Update article, as plain text. For a medicines recall this carries the affected batch numbers and expiry dates, the PL number, the active ingredient, the recall class and the required action.
- `mhra_drug_safety_update(query?, published_from?, published_to?, limit?, offset?)` — articles from Drug Safety Update, the MHRA monthly prescriber bulletin (new contraindications, updated warnings, monitoring advice).

### Alert categories

`alert_type` accepts one of five slugs (document counts observed 2026-09-13, 1,440 alerts total):

| slug | what it is | count |
|---|---|---|
| `field-safety-notices` | Field Safety Notices from device manufacturers, published weekly | 615 |
| `medicines-recall-notification` | Class 1–4 medicines recalls and defect notifications, with affected batches | 587 |
| `device-safety-information` | MHRA safety information about a device already on the market | 203 |
| `mhra-safety-round-up` | periodic MHRA round-up of device and medicine safety issues | 18 |
| `national-patient-safety` | National Patient Safety Alerts requiring NHS-wide action | 17 |

## Auth

None. The GOV.UK Search and Content APIs are open and unauthenticated.

## Upstream behaviour worth knowing

- **Errors are HTML, not JSON.** A bad filter value, an unknown `order` or a malformed date returns **HTTP 422 with a full GOV.UK error page**. The pack validates `alert_type` and every date up front and never hands a non-JSON body to a caller.
- **`order=-issued_date` is rejected (422).** `public_timestamp` is the only sortable field, and the two disagree: the FSN roundup issued 2026-08-31 was published 2026-09-09, so "newest published" and "newest issued" return different leaders. `sort` is therefore an argument. `newest_issued` (the default) sorts the 500 most recently published matches by issue date and reports `sort_covered_all_matches` so a partial ordering is never presented as a complete one; narrowing with `issued_from`/`issued_to` makes it complete.
- **With no `q` and no `order`, results come back by relevance**, which for an empty query is effectively arbitrary — a "recent alerts" call written without an explicit order returns 2022 articles above 2026 ones and still looks sorted. Order is always set explicitly.
- **Filters here are honest**, which is worth recording because it is not the norm: `filter_alert_type=zzz-nonsense` returns 0 rather than the unfiltered set. A zero really is a zero.
- **Weekly Field Safety Notice roundups link out to PDFs** hosted off GOV.UK, so `mhra_alert_detail` on one of those returns the roundup page rather than individual manufacturer notices. Medicines recalls and device safety information carry their full content inline.

## Data sources

- Search API: `https://www.gov.uk/api/search.json` — <https://docs.publishing.service.gov.uk/repos/search-api.html>
- Content API: `https://www.gov.uk/api/content/` — <https://content-api.publishing.service.gov.uk/>
- Publisher: Medicines and Healthcare products Regulatory Agency (MHRA), <https://www.gov.uk/drug-device-alerts>

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "mhra-alerts": {
      "url": "https://gateway.pipeworx.io/mhra-alerts/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/mhra-alerts/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/mhra_safety_alerts \
  -H 'Content-Type: application/json' \
  -d '{"issued_from":"2026-08-01","issued_to":"2026-09-01","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/mhra_safety_alerts`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "mhra-alerts": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-mhra-alerts"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-mhra-alerts
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Mhra Alerts data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
