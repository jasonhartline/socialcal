// src/worker.ts

import * as chrono from "chrono-node";
import ical, { ICalCalendar } from "ical-generator";
import { DateTime } from "luxon";

const BSKY_PUBLIC = "https://public.api.bsky.app/xrpc";
const FOOTER_LINE = "Automatic event from BlueSky via SocialCal: https://socialcal.org/";

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

type WhenSpec =
  | { kind: "timed"; start: DateTime; end: DateTime }
  | { kind: "allday"; startDate: { y: number; m: number; d: number }; endDateExclusive: { y: number; m: number; d: number } };

// helper: add days to a Y-M-D triple (in UTC)
function addDaysUTC(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const dt = DateTime.utc(y, m, d).plus({ days });
  return { y: dt.year, m: dt.month, d: dt.day };
}

// Parse bracket into either:
// - timed event with start/end DateTime (timezone required)
// - all-day single/multi-day with DTSTART/DTEND (timezone optional / ignored)
function parseWhenSpec(bracket: string, referenceISO: string, defaultDurationMin: number): WhenSpec | null {
  const raw = bracket.trim();

  // If the last token looks like a timezone, we’ll strip it; otherwise TZ is absent.
  const tokens = raw.split(/\s+/);
  const last = tokens[tokens.length - 1] ?? "";
  const tzParsed = parseTimezoneToken(raw); // uses existing logic: requires TZ token at end
  const hasExplicitTZ = tzParsed !== null;

  // For parsing the human time expression, we want just the “expr” part when TZ exists.
  const expr = hasExplicitTZ ? tzParsed!.expr : raw;

  const reference = new Date(referenceISO);
  const results = chrono.parse(expr, reference, { forwardDate: true });
  if (!results?.length) return null;

  const r = results[0];
  const s = r.start;

  const startHasHour = s.isCertain("hour") || s.isCertain("minute");

  // ---- ALL-DAY: no time present
  if (!startHasHour) {
    const sy = s.get("year"), sm = s.get("month"), sd = s.get("day");

    // Multi-day all-day if chrono provided an end date
    if (r.end) {
      const e = r.end;
      const ey = e.get("year"), em = e.get("month"), ed = e.get("day");

      // User intent is inclusive, ICS DTEND is exclusive => add 1 day to end date
      const endExclusive = addDaysUTC(ey, em, ed, 1);
      return {
        kind: "allday",
        startDate: { y: sy, m: sm, d: sd },
        endDateExclusive: endExclusive,
      };
    }

    // Single-day all-day => DTEND is next day
    const endExclusive = addDaysUTC(sy, sm, sd, 1);
    return {
      kind: "allday",
      startDate: { y: sy, m: sm, d: sd },
      endDateExclusive: endExclusive,
    };
  }

  // ---- TIMED: time present => TZ required
  if (!hasExplicitTZ) return null;

  // Build start DateTime (local clock time) then apply tz -> DateTime
  const sh = s.get("hour");
  const smin = s.isCertain("minute") ? s.get("minute") : 0;
  const ss = s.isCertain("second") ? s.get("second") : 0;

  const sBase = DateTime.fromObject(
    { year: s.get("year"), month: s.get("month"), day: s.get("day"), hour: sh, minute: smin, second: ss },
    { zone: "UTC" }
  );
  const startZ = applyZone(sBase, tzParsed!.zone);
  if (!startZ || !startZ.isValid) return null;

  // End time:
  // - If chrono returns an end (e.g., "9am-5pm"), use it.
  // - Otherwise use default duration.
  let endZ: DateTime;
  if (r.end) {
    const e = r.end;
    const eh = e.isCertain("hour") ? e.get("hour") : sh;
    const emin = e.isCertain("minute") ? e.get("minute") : 0;
    const esec = e.isCertain("second") ? e.get("second") : 0;

    const eBase = DateTime.fromObject(
      { year: e.get("year"), month: e.get("month"), day: e.get("day"), hour: eh, minute: emin, second: esec },
      { zone: "UTC" }
    );
    const ez = applyZone(eBase, tzParsed!.zone);
    if (!ez || !ez.isValid) return null;
    endZ = ez;
  } else {
    endZ = startZ.plus({ minutes: defaultDurationMin });
  }

  // Guard: if user wrote a backwards range, still keep something sensible
  if (endZ <= startZ) endZ = startZ.plus({ minutes: defaultDurationMin });

  return { kind: "timed", start: startZ, end: endZ };
}

// For all-day, build UTC-midnight JS Dates
function utcMidnightDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
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
      const spec = parseWhenSpec(e.whenBracket, e.referenceISO, defaultDurationMin);
    if (!spec) continue;

    const url =
      e.kind === "full"
        ? toBskyPermalink(e.sourceHandle, e.sourceUri)
        : toBskyPermalink(e.sourceHandle, e.detailsUri);

    // Always append the footer line
    const descParts = [e.details.trim()];
    if (url) descParts.push(url);
    descParts.push(FOOTER_LINE);
    const description = descParts.filter(Boolean).join("\n\n");

    const uid =
      e.kind === "full"
        ? `${e.sourceUri}#${e.whenBracket}`
        : `${e.headerUri}->${e.detailsUri}#${e.whenBracket}`;

    if (spec.kind === "allday") {
      const start = utcMidnightDate(spec.startDate.y, spec.startDate.m, spec.startDate.d);
      const end = utcMidnightDate(spec.endDateExclusive.y, spec.endDateExclusive.m, spec.endDateExclusive.d);

      cal.createEvent({
        id: uid,
        allDay: true,
        start,
        end,
        summary: e.title,
        description,
        url: url ?? undefined,
      });
    } else {
      cal.createEvent({
        id: uid,
        start: spec.start.toJSDate(),
        end: spec.end.toJSDate(),
        summary: e.title,
        description,
        url: url ?? undefined,
      });
    }
  }

  return cal.toString();
}

// =====================
// Troubleshoot
// =====================
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function troubleshoot(handle: string, defaultDurationMin = 60): Promise<string> {
  type Card =
    | { kind: "event"; title: string; when: string; start: string; end: string; allDay: boolean; description: string; source: string }
    | { kind: "skip"; source: string; reason: string };

  const cards: Card[] = [];

  let cursor: string | undefined = undefined;
  let considered = 0;

  const PAGES = 2; // cheap
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
      if (!hasSocialcal(txt)) continue; // show only likely-intended items

      const created = getPostCreatedAt(post);

      // Collect candidate events the same way the calendar does
      const derived: CandidateEvent[] = [];

      const full = buildEventFromFullPost(post);
      if (full) derived.push(full);

      const isReply = !!post?.record?.reply?.parent?.uri;
      if (isReply && hasSocialcal(txt)) {
        const more = await deriveReplyTriggeredEvents(post);
        derived.push(...more);
      }

      if (derived.length === 0) {
        // Give a best reason
        const hdr = parseReplyHeaderFormat(txt);
        if (hdr) {
          const spec = parseWhenSpec(hdr.when, created, defaultDurationMin);
          const reason = spec ? "Header format belongs in a reply (or use full format in a post)." : "Header found but timezone missing/invalid (timed events require TZ).";
          cards.push({ kind: "skip", source: post.uri, reason });
        } else {
          cards.push({ kind: "skip", source: post.uri, reason: "Contains #socialcal but does not match required format." });
        }
      } else {
        for (const e of derived) {
          const spec = parseWhenSpec(e.whenBracket, e.referenceISO, defaultDurationMin);
          if (!spec) {
            cards.push({ kind: "skip", source: e.kind === "full" ? e.sourceUri : e.headerUri, reason: "Could not parse date/time (timed events require a supported timezone)." });
            continue;
          }

          const url =
            e.kind === "full"
              ? toBskyPermalink(e.sourceHandle, e.sourceUri)
              : toBskyPermalink(e.sourceHandle, e.detailsUri);

          const descParts = [e.details.trim()];
          if (url) descParts.push(url);
          descParts.push(FOOTER_LINE);
          const description = descParts.filter(Boolean).join("\n\n");

          if (spec.kind === "allday") {
            const start = DateTime.utc(spec.startDate.y, spec.startDate.m, spec.startDate.d).toISODate();
            const endEx = DateTime.utc(spec.endDateExclusive.y, spec.endDateExclusive.m, spec.endDateExclusive.d).toISODate();
            cards.push({
              kind: "event",
              title: e.title,
              when: e.whenBracket,
              start: start ?? "",
              end: endEx ?? "",
              allDay: true,
              description,
              source: e.kind === "full" ? e.sourceUri : `${e.headerUri} + ${e.detailsUri}`,
            });
          } else {
            cards.push({
              kind: "event",
              title: e.title,
              when: e.whenBracket,
              start: spec.start.toISO(),
              end: spec.end.toISO(),
              allDay: false,
              description,
              source: e.kind === "full" ? e.sourceUri : `${e.headerUri} + ${e.detailsUri}`,
            });
          }
        }
      }

      considered++;
      if (considered >= 40) break;
    }

    if (considered >= 40 || !cursor) break;
  }

  const eventCards = cards.filter((c) => c.kind === "event") as Extract<Card, { kind: "event" }>[];
  const skipCards = cards.filter((c) => c.kind === "skip") as Extract<Card, { kind: "skip" }>[];;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>SocialCal Troubleshoot</title>
<style>
  body { font-family: system-ui,-apple-system,sans-serif; max-width: 900px; margin: 40px auto; padding: 0 16px; line-height: 1.4; }
  h1 { margin: 0 0 8px 0; }
  .muted { color: #555; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin: 16px 0; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px 14px; background: #fff; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #f1f1f1; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f7f7f7; padding: 10px; border-radius: 8px; }
  a { color: inherit; }
</style>
</head>
<body>
  <h1>SocialCal Troubleshoot</h1>
  <div class="muted">Handle: <b>${esc(handle)}</b></div>

  <h2>Events that will appear in the calendar</h2>
  <div class="grid">
    ${eventCards.length === 0 ? `<div class="muted">No events parsed from recent #socialcal items.</div>` : eventCards.map(e => `
  <div class="card">
    <div class="row" style="justify-content: space-between; align-items: baseline;">
      <div><b>${esc(e.title)}</b></div>
      <div class="pill">${e.allDay ? "all-day" : "timed"}</div>
    </div>

    <div class="muted time"
         data-allday="${e.allDay ? "true" : "false"}"
         data-start="${esc(e.start)}"
         data-end="${esc(e.end)}">
      <!-- filled by JS -->
    </div>

    <div style="margin-top:10px;"><b>Description:</b></div>
    <pre>${esc(e.description)}</pre>
  </div>
`).join("")}
  </div>

  <h2>Skipped items</h2>
  <div class="grid">
    ${skipCards.length === 0 ? `<div class="muted">None.</div>` : skipCards.map(s => `
      <div class="card">
        <div class="muted">Source: <code>${esc(s.source)}</code></div>
        <div><b>Reason:</b> ${esc(s.reason)}</div>
      </div>
    `).join("")}
  </div>

  <div class="muted" style="margin-top:24px;">
    Reminder: timed events require TZ (ET/CT/MT/PT, IANA like America/Chicago, Z, or ±HH:MM). Date-only events are all-day and TZ is optional.
  </div>
</body>
<script>
(function () {
  const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  for (const el of document.querySelectorAll(".time")) {
    const allDay = el.dataset.allday === "true";
    const start = el.dataset.start ? new Date(el.dataset.start) : null;
    const end = el.dataset.end ? new Date(el.dataset.end) : null;
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
      el.textContent = "";
      continue;
    }

    if (allDay) {
      // end is exclusive; display inclusive end date
      const endInclusive = new Date(end.getTime());
      endInclusive.setDate(endInclusive.getDate() - 1);

      el.textContent = sameDay(start, endInclusive)
        ? fmtDate.format(start)
        : fmtDate.format(start) + " – " + fmtDate.format(endInclusive);
    } else {
      el.textContent = fmtDate.format(start) + " · " + fmtTime.format(start) + " – " + fmtTime.format(end);
    }
  }
})();
</script>
</html>`;
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
        const report = await troubleshoot(handle, defaultDurationMin);
        await cachePut(env, handle, "ts", report, "text/html; charset=utf-8", tsTtl);
        return new Response(report, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
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
