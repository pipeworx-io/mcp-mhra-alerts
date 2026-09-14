interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * MHRA drug and device safety alerts, recalls and Drug Safety Update bulletins,
 * sourced from the GOV.UK Search and Content APIs (keyless).
 *
 * Scope note for whoever edits this next: `mcps/mhra-uk` covers MHRA PRODUCT
 * documents (SmPC / PIL / PAR) — what a licensed medicine is and what its
 * label says. This pack covers what went WRONG with one: batch recalls, field
 * safety notices, device safety information and safety-signal bulletins. The
 * two must not capture each other's queries, which is why every description
 * here leads with recall/alert/safety-signal vocabulary and none of them
 * mention product information.
 *
 * Upstream traps, all measured live 2026-09-13 — read before "fixing" anything:
 *
 *  1. AN ERROR IS AN HTML PAGE, NOT JSON. A bad filter value, an unknown
 *     `order`, or a malformed date returns HTTP 422 with a full GOV.UK error
 *     page. `res.json()` throws a parser complaint that reads as our bug, and
 *     forwarding `res.text()` puts a `<!DOCTYPE html>` document inside a JSON
 *     field. Everything goes through `govukGet`, which refuses to hand a
 *     non-JSON body to a caller.
 *
 *  2. `order=-issued_date` IS REJECTED (422). The only sortable field is
 *     `public_timestamp`, and the two disagree: an FSN roundup published on
 *     2026-09-09 carries issued_date 2026-08-31, so "newest published" and
 *     "newest issued" return different leaders. Rather than pick one silently,
 *     `sort` is an argument, `newest_issued` sorts a bounded window client-side,
 *     and the response says whether that window covered the whole match set.
 *
 *  3. WITH NO `q` AND NO `order`, RESULTS COME BACK BY RELEVANCE — which for an
 *     empty query is effectively arbitrary. A "recent alerts" call written
 *     without an explicit order returns 2022 articles above 2026 ones and looks
 *     fine. Order is always set explicitly below.
 *
 *  4. Filters are honest here, which is worth recording because it is not the
 *     norm: `filter_alert_type=zzz-nonsense` returns 0 rather than the
 *     unfiltered set, and a malformed date 422s rather than being ignored. So a
 *     zero here really does mean zero.
 */


const BASE = 'https://www.gov.uk';
const UA = 'pipeworx-mcp-mhra-alerts/1.0 (+https://pipeworx.io)';
const MHRA_ORG = 'medicines-and-healthcare-products-regulatory-agency';

/** Largest match set we will pull down to sort by issued date client-side. */
const SORT_WINDOW = 500;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'GOV.UK Search/Content API (MHRA)');
}

/**
 * The five alert categories MHRA actually publishes. These slugs are validated
 * rather than passed through, because GOV.UK answers an unknown one with a
 * clean HTTP 200 and zero results — indistinguishable from a category that
 * genuinely has no alerts, which is the wrong thing to tell a caller asking
 * whether their medicine was recalled. Per-category counts as of the build are
 * in the README; if one of these slugs stops matching anything, compare against
 * those before assuming the caller is at fault.
 */
const ALERT_TYPES: Record<string, string> = {
  'field-safety-notices': 'Field Safety Notices issued by device manufacturers and published weekly by MHRA',
  'medicines-recall-notification': 'Class 1-4 medicines recalls and defect notifications, with affected batch numbers',
  'device-safety-information': 'MHRA safety information about a medical device already on the market',
  'national-patient-safety': 'National Patient Safety Alerts requiring action across the NHS',
  'mhra-safety-round-up': 'Periodic MHRA round-up of device and medicine safety issues',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'mhra_safety_alerts',
    description:
      'UK medicines and medical device safety alerts published by the MHRA on GOV.UK: Class 1-4 medicines recalls with affected batch numbers, Field Safety Notices from device manufacturers, device safety information, and National Patient Safety Alerts. Answers "has this medicine or device been recalled in the UK", "which batches were withdrawn", and "what safety alerts were issued last month". Returns each alert with its title, alert category, issue date, one-line summary and GOV.UK URL; filter by free text, category, issue-date range and clinical specialism.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search over alert titles and summaries, e.g. a medicine name ("fingolimod"), a manufacturer ("Zentiva") or a device type ("infusion pump").' },
        alert_type: { type: 'string', description: `Restrict to one alert category. One of: ${Object.keys(ALERT_TYPES).join(', ')}.` },
        issued_from: { type: 'string', description: 'Earliest issue date, YYYY-MM-DD.' },
        issued_to: { type: 'string', description: 'Latest issue date, YYYY-MM-DD.' },
        specialism: { type: 'string', description: 'Clinical specialism slug the alert is tagged for, e.g. "pharmacy", "dispensing-gp-practices", "medical-devices".' },
        sort: { type: 'string', description: '"newest_issued" (default) orders by the date MHRA issued the alert; "newest_published" orders by when the GOV.UK page went live. They differ — a weekly notice issued on the 31st can publish on the 9th of the next month.' },
        limit: { type: 'number', description: 'Alerts to return, 1-100 (default 20).' },
        offset: { type: 'number', description: 'Results to skip, for paging (default 0).' },
      },
    },
  },
  {
    name: 'mhra_alert_detail',
    description:
      'Full text of one MHRA safety alert or recall from GOV.UK, given the alert URL or path returned by mhra_safety_alerts. Returns the complete notice as plain text — for a medicines recall that means the affected batch numbers and expiry dates, the marketing authorisation (PL) number, the active ingredient, the recall class and the action the recipient must take — plus the issue date, alert category and any withdrawal notice.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The alert URL or GOV.UK path, e.g. "/drug-device-alerts/class-2-medicines-recall-zentiva-pharma-uk-limited-fingolimod-zentiva-0-dot-5-mg-capsules-el-26-a-slash-37" or the full https://www.gov.uk/... form.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'mhra_drug_safety_update',
    description:
      'Articles from Drug Safety Update, the MHRA monthly bulletin that tells UK prescribers about new safety signals: new contraindications, updated warnings, restricted indications and monitoring advice for medicines already in use. The UK counterpart to an FDA drug safety communication. Answers "what new safety advice has the MHRA issued about this medicine". Returns title, publication date, summary and GOV.UK URL; filter by free text and date range, then pass a URL to mhra_alert_detail for the full article.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search, e.g. a drug name ("metformin", "domperidone") or a safety topic ("angioedema").' },
        published_from: { type: 'string', description: 'Earliest publication date, YYYY-MM-DD.' },
        published_to: { type: 'string', description: 'Latest publication date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Articles to return, 1-100 (default 20).' },
        offset: { type: 'number', description: 'Results to skip, for paging (default 0).' },
      },
    },
  },
];

// ---------------------------------------------------------------- helpers

function bad(message: string): never {
  throw new Error(`user_error: ${message}`);
}

function asInt(v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Dates are validated here rather than passed through, because GOV.UK answers a
 * malformed one with a 422 HTML page — a caller who typed "August 2026" would
 * otherwise get an upstream error instead of being told the format.
 */
function asDate(v: unknown, key: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) bad(`"${key}" must be a date in YYYY-MM-DD form; got "${s}".`);
  if (Number.isNaN(Date.parse(`${s}T00:00:00Z`))) bad(`"${key}" is not a real calendar date: "${s}".`);
  return s;
}

function dateFilter(from?: string, to?: string): string | undefined {
  const parts: string[] = [];
  if (from) parts.push(`from:${from}`);
  if (to) parts.push(`to:${to}`);
  return parts.length ? parts.join(',') : undefined;
}

/**
 * The one place an upstream response becomes JSON. GOV.UK returns an HTML error
 * page on 422/404/5xx, so a bare `res.json()` here would surface as a parser
 * complaint and a bare `res.text()` would put a whole HTML document inside the
 * caller's result.
 */
async function govukGet(path: string): Promise<Record<string, unknown>> {
  const res = await pwFetch(`${BASE}${path}`);
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (res.status === 404) throw new Error(`not_found: GOV.UK has no document at ${path.split('?')[0]}.`);
    if (res.status === 422) throw new Error('user_error: GOV.UK rejected one of the search filters. Check alert_type is one of the documented slugs and that any date is YYYY-MM-DD.');
    throw new Error(`upstream_down: GOV.UK returned HTTP ${res.status} and a non-JSON body for ${path.split('?')[0]}.`);
  }
  if (!res.ok) {
    const msg = (parsed as { message?: string } | null)?.message;
    if (res.status === 404) throw new Error(`not_found: GOV.UK has no document at ${path.split('?')[0]}.`);
    throw new Error(`upstream_down: GOV.UK returned HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}.`);
  }
  return parsed as Record<string, unknown>;
}

const SEARCH_FIELDS = 'title,link,description,public_timestamp,issued_date,alert_type,content_id';

interface RawHit {
  title?: string;
  link?: string;
  description?: string;
  public_timestamp?: string;
  issued_date?: string;
  alert_type?: string[];
  content_id?: string;
}

function shape(hit: RawHit) {
  const path = hit.link ?? '';
  return {
    title: hit.title ?? null,
    alert_type: hit.alert_type?.[0] ?? null,
    issued_date: hit.issued_date ?? null,
    published_at: hit.public_timestamp ?? null,
    summary: hit.description ?? null,
    url: path ? `${BASE}${path}` : null,
    path: path || null,
  };
}

async function search(params: URLSearchParams): Promise<{ results: RawHit[]; total: number }> {
  const d = await govukGet(`/api/search.json?${params}`);
  return { results: (d.results as RawHit[]) ?? [], total: Number(d.total ?? 0) };
}

/**
 * HTML → plain text. The alert body is rendered HTML with real tabular content
 * (batch number, expiry, pack size), so rows are flattened with separators
 * rather than collapsed — a recall whose batch table becomes one run-on line is
 * not usable by the person deciding whether their stock is affected.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    // Cells first, and each one collapsed to a single line before the row is
    // joined. Doing this after the generic tag strip put every batch number,
    // expiry and pack size on its own line, which is exactly the form in which
    // a recall table stops telling you which expiry belongs to which batch.
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
      const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      return cells.length ? `\n${cells.join(' | ')}\n` : '';
    })
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- tools

async function safetyAlerts(args: Record<string, unknown>) {
  const limit = asInt(args.limit, 20, 1, 100);
  const offset = asInt(args.offset, 0, 0, 5000);
  const issuedFrom = asDate(args.issued_from, 'issued_from');
  const issuedTo = asDate(args.issued_to, 'issued_to');
  const sort = String(args.sort ?? 'newest_issued');
  if (sort !== 'newest_issued' && sort !== 'newest_published') {
    bad(`"sort" must be "newest_issued" or "newest_published"; got "${sort}".`);
  }

  const alertType = args.alert_type ? String(args.alert_type).trim() : undefined;
  if (alertType && !(alertType in ALERT_TYPES)) {
    bad(`"${alertType}" is not an MHRA alert category. Use one of: ${Object.keys(ALERT_TYPES).join(', ')}.`);
  }

  const base = new URLSearchParams({
    filter_organisations: MHRA_ORG,
    filter_content_store_document_type: 'medical_safety_alert',
    fields: SEARCH_FIELDS,
  });
  if (args.query) base.set('q', String(args.query));
  if (alertType) base.set('filter_alert_type', alertType);
  if (args.specialism) base.set('filter_medical_specialism', String(args.specialism));
  const df = dateFilter(issuedFrom, issuedTo);
  if (df) base.set('filter_issued_date', df);

  let hits: RawHit[];
  let total: number;
  let sortComplete = true;

  if (sort === 'newest_published') {
    // Upstream can do this one itself, so page server-side.
    const p = new URLSearchParams(base);
    p.set('order', '-public_timestamp');
    p.set('count', String(limit));
    p.set('start', String(offset));
    const r = await search(p);
    hits = r.results;
    total = r.total;
  } else {
    // `order=-issued_date` is a 422 upstream, so sort a bounded window here.
    const p = new URLSearchParams(base);
    p.set('order', '-public_timestamp');
    p.set('count', String(SORT_WINDOW));
    p.set('start', '0');
    const r = await search(p);
    total = r.total;
    sortComplete = total <= SORT_WINDOW;
    hits = r.results
      .slice()
      .sort((a, b) => String(b.issued_date ?? '').localeCompare(String(a.issued_date ?? '')))
      .slice(offset, offset + limit);
  }

  const results = hits.map(shape);
  if (results.length === 0) {
    return {
      found: false,
      reason: 'no_matching_alerts',
      hint: `MHRA published no safety alert matching those filters. Widen the issue-date range, drop alert_type, or try mhra_drug_safety_update for safety-signal bulletins rather than recalls. For a medicine's licensed product information (SmPC, PIL, PAR) rather than a recall, use the mhra_search tool.`,
      total_matching: total,
      filters_applied: { query: args.query ?? null, alert_type: alertType ?? null, issued_from: issuedFrom ?? null, issued_to: issuedTo ?? null, specialism: args.specialism ?? null },
      source: 'MHRA safety alerts published on GOV.UK (Search API)',
    };
  }

  return {
    found: true,
    total_matching: total,
    returned: results.length,
    sort,
    // Only meaningful for newest_issued: says whether the client-side sort saw
    // every match, so a caller is never quietly handed a partial ordering.
    sort_covered_all_matches: sort === 'newest_issued' ? sortComplete : true,
    ...(sort === 'newest_issued' && !sortComplete
      ? { sort_note: `Ordered the ${SORT_WINDOW} most recently published of ${total} matches by issue date. Narrow with issued_from/issued_to for a complete ordering.` }
      : {}),
    alerts: results,
    alert_categories: ALERT_TYPES,
    source: 'MHRA safety alerts published on GOV.UK (Search API)',
  };
}

async function alertDetail(args: Record<string, unknown>) {
  const raw = String(args.url ?? '').trim();
  if (!raw) bad('Required argument "url" is missing. Pass an alert URL or path from mhra_safety_alerts, e.g. "/drug-device-alerts/class-2-medicines-recall-...".');

  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      bad(`"${raw}" is not a URL or a GOV.UK path.`);
    }
    if (!/(^|\.)gov\.uk$/i.test(u!.hostname)) {
      bad(`mhra_alert_detail reads GOV.UK documents; "${u!.hostname}" is not a gov.uk host.`);
    }
    path = u!.pathname;
  }
  if (!path.startsWith('/')) path = `/${path}`;

  const d = await govukGet(`/api/content${path}`);
  const details = (d.details ?? {}) as Record<string, unknown>;
  const meta = (details.metadata ?? {}) as Record<string, unknown>;
  const bodyHtml = typeof details.body === 'string' ? details.body : '';
  const withdrawn = d.withdrawn_notice as { explanation?: string; withdrawn_at?: string } | undefined;

  return {
    found: true,
    title: (d.title as string) ?? null,
    document_type: (d.document_type as string) ?? null,
    alert_type: (meta.alert_type as string) ?? null,
    issued_date: (meta.issued_date as string) ?? null,
    medical_specialism: (meta.medical_specialism as string[]) ?? [],
    first_published_at: (d.first_published_at as string) ?? null,
    last_updated_at: (d.public_updated_at as string) ?? null,
    withdrawn: withdrawn?.withdrawn_at
      ? { withdrawn_at: withdrawn.withdrawn_at, explanation: withdrawn.explanation ? htmlToText(withdrawn.explanation) : null }
      : null,
    summary: (d.description as string) ?? null,
    body_text: bodyHtml ? htmlToText(bodyHtml) : null,
    url: `${BASE}${path}`,
    source: 'MHRA alert published on GOV.UK (Content API)',
  };
}

async function drugSafetyUpdate(args: Record<string, unknown>) {
  const limit = asInt(args.limit, 20, 1, 100);
  const offset = asInt(args.offset, 0, 0, 5000);
  const from = asDate(args.published_from, 'published_from');
  const to = asDate(args.published_to, 'published_to');

  const p = new URLSearchParams({
    filter_organisations: MHRA_ORG,
    filter_content_store_document_type: 'drug_safety_update',
    fields: SEARCH_FIELDS,
    // Explicit, always: with no order GOV.UK sorts by relevance, which for an
    // empty query puts 2022 articles above 2026 ones and still looks sorted.
    order: '-public_timestamp',
    count: String(limit),
    start: String(offset),
  });
  if (args.query) p.set('q', String(args.query));
  const df = dateFilter(from, to);
  if (df) p.set('filter_public_timestamp', df);

  const { results, total } = await search(p);
  const articles = results.map(shape).map(({ alert_type: _ignored, issued_date: _issued, ...rest }) => rest);

  if (articles.length === 0) {
    return {
      found: false,
      reason: 'no_matching_bulletins',
      hint: 'No Drug Safety Update article matched. Widen the date range, or try mhra_safety_alerts if you are looking for a batch recall or a device field safety notice rather than prescribing advice.',
      total_matching: total,
      source: 'MHRA Drug Safety Update on GOV.UK (Search API)',
    };
  }

  return {
    found: true,
    total_matching: total,
    returned: articles.length,
    articles,
    source: 'MHRA Drug Safety Update on GOV.UK (Search API)',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'mhra_safety_alerts':
      return safetyAlerts(args);
    case 'mhra_alert_detail':
      return alertDetail(args);
    case 'mhra_drug_safety_update':
      return drugSafetyUpdate(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
