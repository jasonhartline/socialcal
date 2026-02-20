// src/worker.ts
import chrono from "chrono-node";
import ical, { ICalCalendar } from "ical-generator";
import { DateTime } from "luxon";

const BSKY_PUBLIC = "https://public.api.bsky.app/xrpc";

// =====================
// Env + config knobs
// =====================
type Env = {
  RATE_LIMITER: DurableObjectNamespace;

  RL_CAPACITY?: string;
  RL_WINDOW_SEC?: string;
  RL_BURST?: string;

  ICS_TTL_SEC?: string;
  ICS_MAX_AGE_SEC?: string;
  ICS_SWR_SEC?: string;

  TS_TTL_SEC?: string;

  DEFAULT_DURATION_MIN?: string;
};

function envInt(env: Env, key: keyof Env, def: number): number {
  const raw = env[key];
  const n = raw !== undefined ? parseInt(String(raw), 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function rlConfig(env: Env) {
  const capacity = envInt(env, "RL_CAPACITY", 60);
  const windowSec = envInt(env, "RL_WINDOW_SEC", 3600);
  const burst = envInt(env, "RL_BURST", 10);
  return { capacity, windowSec, burst };
}

function cacheConfig(env: Env) {
  const icsTtl = envInt(env, "ICS_TTL_SEC", 60);
  const icsMaxAge = envInt(env, "ICS_MAX_AGE_SEC", 60);
  const icsSwr = envInt(env, "ICS_SWR_SEC", 300);
  const tsTtl = envInt(env, "TS_TTL_SEC", 20);
  const defaultDurationMin = envInt(env, "DEFAULT_DURATION_MIN", 60);
  return { icsTtl, icsMaxAge, icsSwr, tsTtl, defaultDurationMin };
}

function rateKey(handle: string): string {
  return handle.trim().toLowerCase();
}

// =====================
// Timezone rules (v1)
// =====================
const US_TZ_MAP: Record<string, string> = {
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
  PT: "America/Los_Angeles",
};

function normalizeText(s: string): string {
  return (s ?? "").replace(/\r\n/g, "\n");
}

function hasSocialcal(text: string): boolean {
  return /(^|\s)#socialcal(\b|$)/i.test(text);
}

function isHashtagOnly(text: string): boolean {
  return /^\s*#socialcal\s*$/i.test(text.trim());
}

function parseBracketHeaderLine(line: string): { bracket: string; titleRemainder: string } | null {
  const m = line.match(/^\s*\[(.+?)\]\s+(.+?)\s*$/);
  if (!m) return null;
  return { bracket: m[1].trim(), titleRemainder: m[2].trim() };
}

function parseFullEventFormat(text: string): { when: string; title: string; details: string } | null {
  const t = normalizeText(text);
  const parts = t.split("\n");
  if (parts.length < 2) return null;

  const header = parseBracketHeaderLine(parts[0]);
  if (!header) return null;

  // require at least one blank line after header
  let i = 1;
  if (i >= parts.length) return null;
  if (parts[i].trim() !== "") return null;
  while (i < parts.length && parts[i].trim() === "") i++;

  const details = parts.slice(i).join("\n").trim();
  if (!details) return null;

  // For a full event post, tag must appear in body (per your manual).
  if (!hasSocialcal(details)) return null;

  return { when: header.bracket, title: header.titleRemainder, details };
}

function parseReplyHeaderFormat(text: string): { when: string; title: string } | null {
  const t = normalizeText(text).trim();
  const firstLine = t.split("\n")[0].trim();
  if (!hasSocialcal(firstLine)) return null;

  // Strip "#socialcal ..." from end of line for title parsing
  const stripped = firstLine.replace(/\s+#socialcal\b.*$/i, "").trim();
  const header = parseBracketHeaderLine(stripped);
  if (!header) return null;

  return { when: header.bracket, title: header.titleRemainder };
}

function parseTimezoneToken(bracket: string): { expr: string; zone: string } | null {
  const tokens = bracket.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  const tzToken = tokens[tokens.length - 1];
  const expr = tokens.slice(0, -1).join(" ").trim();
  if (!expr) return null;

  // US short forms
  if (US_TZ_MAP[tzToken]) return { expr, zone: US_TZ_MAP[tzToken] };

  // IANA zone (basic check; Luxon validates)
  if (/^[A-Za-z]+\/[A-Za-z_]+$/.test(tzToken)) return { expr, zone: tzToken };

  // ISO offset ±HH:MM or Z
  if (tzToken === "Z") return { expr, zone: "UTC" };
  if (/^[+-]\d{2}:\d{2}$/.test(tzToken)) return { expr, zone: `OFFSET${tzToken}` };

  return null;
}

function applyZone(dt: DateTime, zone: string): DateTime | null {
  if (zone.startsWith("OFFSET")) {
    const m = zone.match(/^OFFSET([+-])(\d{2}):(\d{2})$/);
    if (!m) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const minutes = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    const shifted = DateTime.utc(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond).minus({ minutes });
    return shifted.setZone("UTC");
  }
  const z = dt.setZone(zone, { keepLocalTime: true });
  return z.isValid ? z : null;
}

function parseWhen(bracket: string, referenceISO: string): DateTime | null {
  const tz = parseTimezoneToken(bracket);
  if (!tz) return null;

  const reference = new Date(referenceISO);
  const results = chrono.parse(tz.expr, reference, { forwardDate: true });
  if (!results?.length) return null;

  const start = results[0].start;
  const year = start.get("year");
  const month = start.get("month");
  const day = start.get("day");
  const hour = start.isCertain("hour") ? start.get("hour") : 0;
  const minute = start.isCertain("minute") ? start.get("minute") : 0;
  const second = start.isCertain("second") ? start.get("second") : 0;

  const base = DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: "UTC" });
  if (!base.isValid) return null;

  const zoned = applyZone(base, tz.zone);
  return zoned && zoned.isValid ? zoned : null;
}

// =====================
// Bluesky fetch helpers
// =====================
async function bskyGet(path: string, params: Record<string, string | number | undefined>): Promise<any> {
  const url = new URL(`${BSKY_PUBLIC}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Bluesky ${path} failed: ${res.status} ${msg}`);
  }
  return res.json();
}

type PostView = {
  uri: string;
  author?: { handle?: string; did?: string };
  record: any;
  indexedAt?: string;
};

function getPostText(p: PostView): string {
  return normalizeText(String(p?.record?.text ?? ""));
}

function getPostCreatedAt(p: PostView): string {
  return String(p?.record?.createdAt ?? p?.indexedAt ?? new Date().toISOString());
}

function isRepostItem(item: any): boolean {
  return item?.reason?.$type === "app.bsky.feed.defs#reasonRepost";
}

function toBskyPermalink(handle: string | undefined, uri: string): string | null {
  const m = uri.match(/\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!m) return null;
  const rkey = m[1];
  if (!handle) return `https://bsky.app/post/${rkey}`;
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

async function fetchThreadAncestors(replyUri: string, parentHeight = 20): Promise<any[]> {
  const data = await bskyGet("app.bsky.feed.getPostThread", {
    uri: replyUri,
    depth: 0,
    parentHeight,
  });
  const chain: any[] = [];
  let node = data?.thread;
  if (!node || !node.post) return chain;
  while (node && node.post) {
    chain.push(node.post);
    node = node.parent;
  }
  return chain; // [reply, parent, grandparent, ...]
}

function asPostView(p: any): PostView {
  return p as PostView;
}

// =====================
// Reply semantics (your spec)
// =====================
type CandidateEvent =
  | { kind: "full"; sourceUri: string; sourceHandle?: string; whenBracket: string; title: string; details: string; referenceISO: string }
  | { kind: "combo"; headerUri: string; detailsUri: string; sourceHandle?: string; whenBracket: string; title: string; details: string; referenceISO: string };

function eventKey(e: CandidateEvent): string {
  return e.kind === "full" ? `full:${e.sourceUri}` : `combo:${e.headerUri}->${e.detailsUri}`;
}

function buildEventFromFullPost(p: PostView): CandidateEvent | null {
  const full = parseFullEventFormat(getPostText(p));
  if (!full) return null;
  return {
    kind: "full",
    sourceUri: p.uri,
    sourceHandle: p.author?.handle,
    whenBracket: full.when,
    title: full.title,
    details: full.details,
    referenceISO: getPostCreatedAt(p),
  };
}

function buildEventFromHeaderAndDetails(headerPost: PostView, detailsPost: PostView): CandidateEvent | null {
  const hdr = parseReplyHeaderFormat(getPostText(headerPost));
  if (!hdr) return null;

  const details = getPostText(detailsPost).trim();
  if (!details) return null;

  return {
    kind: "combo",
    headerUri: headerPost.uri,
    detailsUri: detailsPost.uri,
    sourceHandle: headerPost.author?.handle,
    whenBracket: hdr.when,
    title: hdr.title,
    details,
    referenceISO: getPostCreatedAt(headerPost),
  };
}

function firstNonTrivialDetailsPost(ancestors: PostView[]): PostView | null {
  for (let i = 1; i < ancestors.length; i++) {
    const txt = getPostText(ancestors[i]).trim();
    if (!txt) continue;
    if (isHashtagOnly(txt)) continue;
    if (parseReplyHeaderFormat(txt)) continue;
    return ancestors[i];
  }
  return null;
}

async function deriveReplyTriggeredEvents(replyPost: PostView, parentHeight = 20): Promise<CandidateEvent[]> {
  const replyText = getPostText(replyPost);
  if (!hasSocialcal(replyText)) return []; // required by your rule

  const chainRaw = await fetchThreadAncestors(replyPost.uri, parentHeight);
  const chain = chainRaw.map(asPostView);
  if (chain.length < 2) return [];

  const reply = chain[0];
  const parent = chain[1];

  // Case 1: parent is already a full event
  const parentFull = buildEventFromFullPost(parent);
  if (parentFull) return [parentFull];

  // Case 2: parent not full; reply supplies header -> parent supplies details
  const combo = buildEventFromHeaderAndDetails(reply, parent);
  if (combo) return [combo];

  // Case 3: hashtag-only reply binds prior header/full with details
  if (isHashtagOnly(replyText)) {
    // If any ancestor is full event, take nearest
    for (let i = 1; i < chain.length; i++) {
      const full = buildEventFromFullPost(chain[i]);
      if (full) return [full];
    }

    // Else: find a header-format ancestor and its replied-to post
    for (let i = 1; i < chain.length - 1; i++) {
      if (!parseReplyHeaderFormat(getPostText(chain[i]))) continue;
      const evt = buildEventFromHeaderAndDetails(chain[i], chain[i + 1]);
      if (evt) return [evt];
    }

    // Fallback: nearest header anywhere + first non-trivial details
    const anyHeader = chain.find((p, idx) => idx >= 1 && !!parseReplyHeaderFormat(getPostText(p)));
    const details = firstNonTrivialDetailsPost(chain);
    if (anyHeader && details) {
      const evt = buildEventFromHeaderAndDetails(anyHeader, details);
      if (evt) return [evt];
    }
  }

  return [];
}

// =====================
// Collect candidates
// =====================
async function collectCandidates(handle: string): Promise<CandidateEvent[]> {
  const candidates: CandidateEvent[] = [];
  const seen = new Set<string>();

  let cursor: string | undefined = undefined;
  const maxItems = 1000;
  let fetched = 0;

  while (fetched < maxItems) {
    const data = await bskyGet("app.bsky.feed.getAuthorFeed", {
      actor: handle,
      filter: "posts_with_replies",
      limit: 100,
      cursor,
    });

    const feed = Array.isArray(data?.feed) ? data.feed : [];
    cursor = data?.cursor;

    if (feed.length === 0) break;

    for (const item of feed) {
      fetched++;
      const post: PostView = item?.post;
      if (!post?.uri || !post?.record) continue;

      const txt = getPostText(post);

      // Reposts: include reposted content if it is a full event post
      if (isRepostItem(item)) {
        const full = buildEventFromFullPost(post);
        if (full) {
          const k = eventKey(full);
          if (!seen.has(k)) {
            seen.add(k);
            candidates.push(full);
          }
        }
        continue;
      }

      // Posts (including replies) by handle: can be full events themselves
      const full = buildEventFromFullPost(post);
      if (full) {
        const k = eventKey(full);
        if (!seen.has(k)) {
          seen.add(k);
          candidates.push(full);
        }
      }

      // Reply-triggered inclusion (only if this post is a reply and contains #socialcal)
      const isReply = !!post?.record?.reply?.parent?.uri;
      if (isReply && hasSocialcal(txt)) {
        const derived = await deriveReplyTriggeredEvents(post);
        for (const e of derived) {
          const k = eventKey(e);
          if (!seen.has(k)) {
            seen.add(k);
            candidates.push(e);
          }
        }
      }
    }

    if (!cursor) break;
  }

  return candidates;
}

// =====================
// Build ICS
// =====================
function buildCalendar(handle: string, events: CandidateEvent[], defaultDurationMin: number): string {
  const cal: ICalCalendar = ical({
    name: `SocialCalendar: ${handle}`,
    prodId: { company: "socialcalendar.org", product: "socialcalendar", language: "EN" },
  });

  for (const e of events) {
    const when = parseWhen(e.whenBracket, e.referenceISO);
    if (!when) continue;

    const start = when.toJSDate();
    const end = defaultDurationMin > 0 ? when.plus({ minutes: defaultDurationMin }).toJSDate() : undefined;

    const uid =
      e.kind === "full"
        ? `${e.sourceUri}#${when.toISO()}`
        : `${e.headerUri}->${e.detailsUri}#${when.toISO()}`;

    const url =
      e.kind === "full"
        ? toBskyPermalink(e.sourceHandle, e.sourceUri)
        : toBskyPermalink(e.sourceHandle, e.detailsUri);

    const description = url ? `${e.details}\n\n${url}` : e.details;

    cal.createEvent({
      id: uid,
      start,
      end,
      summary: e.title,
      description,
      url: url ?? undefined,
    });
  }

  return cal.toString();
}

// =====================
// Troubleshoot
// =====================
async function troubleshoot(handle: string): Promise<string> {
  const lines: string[] = [];
  lines.push(`SocialCalendar troubleshoot for: ${handle}`);
  lines.push(`(recent items; timezone required; reply rules enabled)`);
  lines.push("");

  let cursor: string | undefined = undefined;
  let shown = 0;

  const PAGES = 2; // up to 200 items
  for (let page = 0; page < PAGES; page++) {
    const data = await bskyGet("app.bsky.feed.getAuthorFeed", {
      actor: handle,
      filter: "posts_with_replies",
      limit: 100,
      cursor,
    });

    const feed = Array.isArray(data?.feed) ? data.feed : [];
    cursor = data?.cursor;

    for (const item of feed) {
      const post: PostView = item?.post;
      if (!post?.uri || !post?.record) continue;

      const txt = getPostText(post);
      const created = getPostCreatedAt(post);
      const kind = isRepostItem(item) ? "repost" : (post?.record?.reply?.parent?.uri ? "reply" : "post");

      // Only show items that contain #socialcal (or reply contains it)
      if (!hasSocialcal(txt)) continue;

      // Full event directly
      const full = parseFullEventFormat(txt);
      if (full) {
        const when = parseWhen(full.when, created);
        if (!when) {
          lines.push(`❌ ${kind}: ${post.uri}`);
          lines.push(`   reason: header datetime missing/invalid timezone (must end with ET/CT/MT/PT, IANA, Z, or ±HH:MM)`);
        } else {
          lines.push(`✅ ${kind}: ${post.uri}`);
          lines.push(`   event: ${full.title}`);
          lines.push(`   when:  ${full.when}  ->  ${when.toISO()}`);
        }
        lines.push("");
        shown++;
        if (shown >= 40) break;
        continue;
      }

      // Reply-triggered
      if (kind === "reply") {
        const derived = await deriveReplyTriggeredEvents(post);
        if (derived.length === 0) {
          lines.push(`❌ reply: ${post.uri}`);
          lines.push(`   reason: reply had #socialcal but could not form an event from parent/header/chain`);
          lines.push("");
        } else {
          for (const e of derived) {
            const when = parseWhen(e.whenBracket, e.referenceISO);
            if (!when) {
              lines.push(`❌ reply-chain: ${post.uri}`);
              lines.push(`   reason: derived event header had missing/invalid timezone`);
              lines.push("");
            } else {
              lines.push(`✅ reply-chain: ${post.uri}`);
              lines.push(`   event: ${e.title}`);
              lines.push(`   when:  ${e.whenBracket}  ->  ${when.toISO()}`);
              lines.push(`   source: ${e.kind === "full" ? e.sourceUri : `${e.headerUri} + ${e.detailsUri}`}`);
              lines.push("");
            }
          }
        }
        shown++;
        if (shown >= 40) break;
        continue;
      }

      // Hashtag present but not parseable
      const hdr = parseReplyHeaderFormat(txt);
      if (hdr) {
        const when = parseWhen(hdr.when, created);
        if (!when) {
          lines.push(`❌ ${kind}: ${post.uri}`);
          lines.push(`   reason: header-format found, but timezone missing/invalid`);
        } else {
          lines.push(`❌ ${kind}: ${post.uri}`);
          lines.push(`   reason: header-format belongs in a REPLY (or use full format in a post)`);
          lines.push(`   header: ${hdr.when} | ${hdr.title}`);
        }
        lines.push("");
      } else {
        lines.push(`❌ ${kind}: ${post.uri}`);
        lines.push(`   reason: contains #socialcal but does not match required format`);
        lines.push("");
      }

      shown++;
      if (shown >= 40) break;
    }

    if (shown >= 40 || !cursor) break;
  }

  if (shown === 0) lines.push("No recent items with #socialcal found.\n");

  lines.push("Reminders:");
  lines.push("- Full post format: [when TZ] Title\\n\\nDetails #socialcal");
  lines.push("- Reply header format: [when TZ] Title #socialcal (one line)");
  lines.push("- TZ must be last token inside brackets (ET/CT/MT/PT, IANA like America/Chicago, Z, or ±HH:MM).");

  return lines.join("\n");
}

// =====================
// DO-based caching + rate limit
// =====================
async function doFetchJson(stub: DurableObjectStub, path: string, payload: any): Promise<Response> {
  return stub.fetch(`https://do.local/${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

async function checkRateLimit(env: Env, handle: string): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const id = env.RATE_LIMITER.idFromName(rateKey(handle));
  const stub = env.RATE_LIMITER.get(id);
  const cfg = rlConfig(env);

  const res = await doFetchJson(stub, "check", { handle: rateKey(handle), cfg });
  if (res.status === 200) return { ok: true };
  if (res.status === 429) {
    const retryAfterSec = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    return { ok: false, retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : 60 };
  }
  return { ok: true };
}

async function cacheGet(env: Env, handle: string, kind: "ics" | "ts"): Promise<{ hit: false } | { hit: true; body: string; contentType: string }> {
  const id = env.RATE_LIMITER.idFromName(rateKey(handle));
  const stub = env.RATE_LIMITER.get(id);
  const res = await doFetchJson(stub, "cache/get", { handle: rateKey(handle), kind });
  if (res.status !== 200) return { hit: false };
  const data = await res.json();
  if (!data?.body || !data?.contentType) return { hit: false };
  return { hit: true, body: String(data.body), contentType: String(data.contentType) };
}

async function cachePut(env: Env, handle: string, kind: "ics" | "ts", body: string, contentType: string, ttlSec: number): Promise<void> {
  const id = env.RATE_LIMITER.idFromName(rateKey(handle));
  const stub = env.RATE_LIMITER.get(id);
  await doFetchJson(stub, "cache/put", { handle: rateKey(handle), kind, body, contentType, ttlSec });
}

// =====================
// Worker entrypoint
// =====================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const handle = url.searchParams.get("handle")?.trim();
    if (!handle) return new Response("Missing handle", { status: 400 });

    // Rate limit per handle (shared across /ics and /troubleshoot)
    const rl = await checkRateLimit(env, handle);
    if (!rl.ok) {
      return new Response("Rate limited", {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSec) },
      });
    }

    const { icsTtl, icsMaxAge, icsSwr, tsTtl, defaultDurationMin } = cacheConfig(env);

    if (url.pathname === "/troubleshoot") {
      // DO cache for a short TTL to prevent bursts
      const cached = await cacheGet(env, handle, "ts");
      if (cached.hit) {
        return new Response(cached.body, {
          headers: {
            "Content-Type": cached.contentType,
            "Cache-Control": "no-store",
          },
        });
      }

      try {
        const report = await troubleshoot(handle);
        await cachePut(env, handle, "ts", report, "text/plain; charset=utf-8", tsTtl);
        return new Response(report, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      } catch (err: any) {
        return new Response(`Error: ${err?.message ?? String(err)}`, { status: 502 });
      }
    }

    if (url.pathname !== "/ics") return new Response("Not Found", { status: 404 });

    // DO cache (per handle) to avoid repeated Bluesky fetches
    const cached = await cacheGet(env, handle, "ics");
    if (cached.hit) {
      return new Response(cached.body, {
        headers: {
          "Content-Type": cached.contentType,
          "Cache-Control": `public, max-age=${icsMaxAge}, stale-while-revalidate=${icsSwr}`,
        },
      });
    }

    let candidates: CandidateEvent[];
    try {
      candidates = await collectCandidates(handle);
    } catch (err: any) {
      return new Response(`Error fetching from Bluesky: ${err?.message ?? String(err)}`, { status: 502 });
    }

    const ics = buildCalendar(handle, candidates, defaultDurationMin);
    await cachePut(env, handle, "ics", ics, "text/calendar; charset=utf-8", icsTtl);

    return new Response(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": `public, max-age=${icsMaxAge}, stale-while-revalidate=${icsSwr}`,
      },
    });
  },
};

// =====================
// Durable Object: rate limiting + per-handle caching
// =====================
export class RateLimiter implements DurableObject {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, "");

    const now = Date.now();
    const body = await request.json().catch(() => ({}));
    const handle = String(body.handle ?? "unknown");

    if (path === "check") {
      const cfg = body.cfg ?? {};
      const CAPACITY = Number.isFinite(cfg.capacity) ? Math.max(1, cfg.capacity) : 60;
      const WINDOW_SEC = Number.isFinite(cfg.windowSec) ? Math.max(10, cfg.windowSec) : 3600;
      const BURST = Number.isFinite(cfg.burst) ? Math.max(0, cfg.burst) : 10;

      const REFILL_PER_MS = CAPACITY / (WINDOW_SEC * 1000);

      const key = `bucket:${handle}`;
      const data = (await this.state.storage.get<any>(key)) ?? {
        tokens: CAPACITY + BURST,
        last: now,
      };

      const elapsed = Math.max(0, now - data.last);
      const refill = elapsed * REFILL_PER_MS;
      let tokens = Math.min(CAPACITY + BURST, data.tokens + refill);

      if (tokens < 1) {
        const msUntil = Math.ceil((1 - tokens) / REFILL_PER_MS);
        const retryAfterSec = Math.max(1, Math.ceil(msUntil / 1000));
        return new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": String(retryAfterSec) },
        });
      }

      tokens -= 1;
      await this.state.storage.put(key, { tokens, last: now });
      return new Response("OK", { status: 200 });
    }

    if (path === "cache/get") {
      const kind = String(body.kind ?? "");
      if (kind !== "ics" && kind !== "ts") return new Response("Bad kind", { status: 400 });

      const key = `cache:${handle}:${kind}`;
      const entry = await this.state.storage.get<any>(key);
      if (!entry) return new Response("MISS", { status: 404 });
      if (now > entry.expiresAt) {
        await this.state.storage.delete(key);
        return new Response("MISS", { status: 404 });
      }
      return new Response(JSON.stringify({ body: entry.body, contentType: entry.contentType }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "cache/put") {
      const kind = String(body.kind ?? "");
      if (kind !== "ics" && kind !== "ts") return new Response("Bad kind", { status: 400 });

      const ttlSec = Number.isFinite(body.ttlSec) ? Math.max(1, Number(body.ttlSec)) : 60;
      const entry = {
        body: String(body.body ?? ""),
        contentType: String(body.contentType ?? "text/plain; charset=utf-8"),
        expiresAt: now + ttlSec * 1000,
      };
      const key = `cache:${handle}:${kind}`;
      await this.state.storage.put(key, entry);
      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }
}
