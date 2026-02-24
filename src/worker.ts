// src/worker.ts

import * as chrono from "chrono-node";
import ical, { ICalCalendar } from "ical-generator";
import { DateTime } from "luxon";
import { RichText } from "@atproto/api";



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
  const defaultDurationMin = envInt(env, "DEFAULT_DURATION_MIN", 60);
  return { icsTtl, icsMaxAge, icsSwr, defaultDurationMin };
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

    // Inherit start date unless end explicitly specifies a date
    const ey = e.isCertain("year") ? e.get("year") : s.get("year");
    const em = e.isCertain("month") ? e.get("month") : s.get("month");
    const ed = e.isCertain("day") ? e.get("day") : s.get("day");

    const eBase = DateTime.fromObject(
      { year: ey, month: em, day: ed, hour: eh, minute: emin, second: esec },
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


function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderRichText(text: string, facets: any): { text: string; html: string } {
  const rt = new RichText({ text: text ?? "", facets });

  let plain = "";
  let html = "";

  for (const seg of rt.segments()) {
    // ---- plain text (ICS)
    if (seg.isLink()) {
      const uri = seg.link?.uri ?? seg.text;
      // keep display if it's already the full uri, otherwise substitute full uri
      plain += uri;
    } else {
      // mentions/tags should stay as written (@handle, #tag) in plain text
      plain += seg.text;
    }

    // ---- html (show)
    const label = escHtml(seg.text);

    if (seg.isLink()) {
      const href = seg.link?.uri ?? "";
      html += `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } else if (seg.isMention()) {
      const did = seg.mention?.did ?? "";
      const href = `https://bsky.app/profile/${did}`;
      html += `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } else if (seg.isTag()) {
      const tag = seg.tag?.tag ?? "";
      const href = `https://bsky.app/search?q=%23${encodeURIComponent(tag)}`;
      html += `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } else {
      html += label;
    }
  }
  

  return { text: plain, html };
}

function sliceFacets(facets: any[] | undefined, startByte: number, endByte: number): any[] {
  if (!facets) return [];
  const out: any[] = [];
  for (const f of facets) {
    const s = f?.index?.byteStart;
    const e = f?.index?.byteEnd;
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (e <= startByte || s >= endByte) continue; // no overlap
    // keep facets fully contained; drop partial overlaps for simplicity/correctness
    if (s < startByte || e > endByte) continue;

    out.push({
      ...f,
      index: { byteStart: s - startByte, byteEnd: e - startByte },
    });
  }
  return out;
}

function extractFullEventDetailsParts(p: PostView): { when: string; title: string; detailsText: string; detailsHtml: string } | null {
  const raw = normalizeText(String(p?.record?.text ?? ""));
  const facets = p?.record?.facets as any[] | undefined;

  // Use your existing parser to get detailsText reliably
  const full = parseFullEventFormat(raw);
  if (!full) return null;

  // Find where details start in raw text by reproducing parseFullEventFormat's split logic
  const parts = raw.split("\n");
  // parts[0] is header line, parts[1] must be blank, then skip blanks
  let i = 1;
  while (i < parts.length && parts[i].trim() === "") i++;
  const detailsStartLine = i;

  const prefix = parts.slice(0, detailsStartLine).join("\n");
  const prefixWithNewline = prefix.length > 0 ? prefix + "\n" : "";

  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8");

  const rawBytes = enc.encode(raw);

  const startByte = enc.encode(prefixWithNewline).length;
  const endByte = rawBytes.length;

  const detailsBytes = rawBytes.slice(startByte, endByte);
  const detailsSubstr = dec.decode(detailsBytes);
  
  const detailsFacets = sliceFacets(facets, startByte, endByte);
  const rendered = renderRichText(detailsSubstr, detailsFacets);

  return {
    when: full.when,
    title: full.title,
    detailsText: rendered.text.trim(),
    detailsHtml: rendered.html
  };
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


function getPostTextParts(p: PostView): { text: string; html: string } {
  const raw = normalizeText(String(p?.record?.text ?? ""));
  const facets = p?.record?.facets;
  return renderRichText(raw, facets);
}

// Keep existing callers working for now
function getPostText(p: PostView): string {
  return getPostTextParts(p).text;
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
  | {
      kind: "full";
      sourceUri: string;
      sourceHandle?: string;
      whenBracket: string;
      title: string;
      details: string;
      detailsHtml: string;
      referenceISO: string;
    }
  | {
      kind: "combo";
      headerUri: string;
      detailsUri: string;
      sourceHandle?: string;
      whenBracket: string;
      title: string;
      details: string;
      detailsHtml: string;
      referenceISO: string;
    };
    

function eventKey(e: CandidateEvent): string {
  return e.kind === "full" ? `full:${e.sourceUri}` : `combo:${e.headerUri}->${e.detailsUri}`;
}

type DerivedEvent = {
  uid: string;
  title: string;
  when: WhenSpec;
  permalink: string | null;
  description: string;     // ICS
  descriptionHtml: string; // Show
};

type DerivedSkip = {
  sourceUri: string;
  reason: string;
};

function candidateUid(e: CandidateEvent): string {
  if (e.kind === "full") return e.sourceUri;
  return e.detailsUri; // canonical for combo
}

function candidatePermalink(e: CandidateEvent): string | null {
  return e.kind === "full"
    ? toBskyPermalink(e.sourceHandle, e.sourceUri)
    : toBskyPermalink(e.sourceHandle, e.detailsUri);
}


function buildEventDescriptionHtml(detailsHtml: string, handle: string): string {
  const d = (detailsHtml ?? "").trim();

  const blueskyProfile = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
  const socialcalShow = `https://socialcal.org/show?handle=${encodeURIComponent(handle)}`;

  const footer = `From Bluesky <a href="${blueskyProfile}" target="_blank" rel="noopener noreferrer">@${escHtml(handle)}</a>\n` +
                 `via SocialCal <a href="${socialcalShow}" target="_blank" rel="noopener noreferrer">${escHtml(socialcalShow)}</a>`;

  return [d, footer].filter((x) => x && x.trim().length > 0).join("\n\n");
}

function buildEventDescription(details: string, handle: string): string {
  const d = (details ?? "").trim();

  const blueskyProfile = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
  const socialcalShow = `https://socialcal.org/show?handle=${encodeURIComponent(handle)}`;

  const footer = `From Bluesky ${blueskyProfile}\nvia SocialCal ${socialcalShow}`;

  return [d, footer].filter((x) => x && x.trim().length > 0).join("\n\n");
}


function deriveFromCandidates(handle: string, events: CandidateEvent[], defaultDurationMin: number): { derived: DerivedEvent[]; skipped: DerivedSkip[] } {

  const derived: DerivedEvent[] = [];
  const skipped: DerivedSkip[] = [];

  for (const e of events) {
    const when = parseWhenSpec(e.whenBracket, e.referenceISO, defaultDurationMin);
    if (!when) {
      skipped.push({
        sourceUri: e.kind === "full" ? e.sourceUri : e.headerUri,
        reason: "Could not parse date/time (timed events require a supported timezone).",
      });
      continue;
    }

    const permalink = candidatePermalink(e);
    const uid = candidateUid(e);

    const description = buildEventDescription(e.details, handle);
    const descriptionHtml = buildEventDescriptionHtml(e.detailsHtml, handle);

    
    derived.push({
      uid,
      title: e.title,
      when,
      permalink,
      description,
      descriptionHtml
    });
  }

  return { derived, skipped };
}


function buildEventFromFullPost(p: PostView): CandidateEvent | null {

  const ex = extractFullEventDetailsParts(p);
  if (!ex) return null;

  return {
    kind: "full",
    sourceUri: p.uri,
    sourceHandle: p.author?.handle,
    whenBracket: ex.when,
    title: ex.title,
    details: ex.detailsText,
    detailsHtml: ex.detailsHtml,
    referenceISO: getPostCreatedAt(p),
  };
  
}

function buildEventFromHeaderAndDetails(headerPost: PostView, detailsPost: PostView): CandidateEvent | null {
  const hdr = parseReplyHeaderFormat(getPostText(headerPost));
  if (!hdr) return null;


  const detailsParts = getPostTextParts(detailsPost);
  const details = detailsParts.text.trim();
  const detailsHtml = detailsParts.html.trim();

  if (!details) return null;
  
  return {
    kind: "combo",
    headerUri: headerPost.uri,
    detailsUri: detailsPost.uri,
    sourceHandle: headerPost.author?.handle,
    whenBracket: hdr.when,
    title: hdr.title,
    details,
    detailsHtml,
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
function buildCalendar(handle: string, events: DerivedEvent[]): string {
  const cal: ICalCalendar = ical({
    name: `SocialCal: @${handle}`,
    prodId: { company: "socialcal.org", product: "socialcal", language: "EN" },
  });
  cal.ttl(60 * 60); // 1 hour



  for (const e of events) {
    if (e.when.kind === "allday") {
      const start = utcMidnightDate(e.when.startDate.y, e.when.startDate.m, e.when.startDate.d);
      const end = utcMidnightDate(e.when.endDateExclusive.y, e.when.endDateExclusive.m, e.when.endDateExclusive.d);

      cal.createEvent({
        id: e.uid,
        allDay: true,
        start,
        end,
        summary: e.title,
        description: e.description,
        url: e.permalink ?? undefined,
      });
    } else {
      cal.createEvent({
        id: e.uid,
        start: e.when.start,
        end: e.when.end,
        summary: e.title,
        description: e.description,
        url: e.permalink ?? undefined,
      });
    }
  }

  return cal.toString();
}

// =====================
// Show / Troubleshoot
// =====================



function eventStartMillis(e: DerivedEvent): number {
  if (e.when.kind === "timed") return e.when.start.toMillis();
  return DateTime.utc(e.when.startDate.y, e.when.startDate.m, e.when.startDate.d).toMillis();
}

function sortEventsByStart(events: DerivedEvent[]): DerivedEvent[] {
  return [...events].sort((a, b) => eventStartMillis(a) - eventStartMillis(b));
}

function troubleshootHTML(handle: string, events: DerivedEvent[], skipped: DerivedSkip[], showErrors: boolean): string {
  const profileUrl = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
  const sorted = sortEventsByStart(events);
  const eventCards = sorted.map((e) => {
    if (e.when.kind === "allday") {
      const startISO =
        DateTime.utc(e.when.startDate.y, e.when.startDate.m, e.when.startDate.d).toISODate() ?? "";
      const endISO =
        DateTime.utc(e.when.endDateExclusive.y, e.when.endDateExclusive.m, e.when.endDateExclusive.d).toISODate() ?? "";
      return { title: e.title, allDay: true, start: startISO, end: endISO, description: e.description, descriptionHtml: e.descriptionHtml };
    } else {
      return {
        title: e.title,
        allDay: false,
        start: e.when.start.toISO() ?? "",
        end: e.when.end.toISO() ?? "",
        description: e.description,
	descriptionHtml: e.descriptionHtml
      };
    }
  });

  return `<!doctype html>
<html>
<head>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta charset="utf-8" />
<title>SocialCal</title>
<style>
  body { font-family: system-ui,-apple-system,sans-serif; max-width: 900px; margin: 40px auto; padding: 0 16px; line-height: 1.4; }
  h1 { margin: 0 0 8px 0; }
  .muted { color: #555; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin: 16px 0; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px 14px; background: #fff; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #f1f1f1; }
  .desc {
    white-space: pre-wrap;
    word-break: break-word;
background: #f7f7f7; padding: 10px; border-radius: 8px; 
  }
  h1::before, h2::before, h3::before {
    content: '';
    display: inline-block;
    height: 1em;
    width: 1em;
    background: url('favicon.svg') no-repeat center / contain;
    vertical-align: baseline;
    position: relative;
    bottom: -0.1em;
    margin-right: 0.3em;
  }
</style>
</head>
<body>
  <h1>SocialCal</h1>
  <div class="muted"><a href="${profileUrl}">@${escHtml(handle)}</a></div>

  ${showErrors && skipped.length > 0 ? `
  <div class="grid" style="margin-top: 16px;">
    <div class="card">
      <div style="margin-bottom: 8px;"><b>Errors</b></div>
      ${skipped.map(s => `
        <div style="margin: 10px 0;">
          <div class="muted"><code>${escHtml(s.sourceUri)}</code></div>
          <div><b>Reason:</b> ${escHtml(s.reason)}</div>
        </div>
      `).join("")}
    </div>
  </div>
` : ""}

  <div class="grid">
    ${eventCards.length === 0 ? `<div class="muted">No events parsed from recent #socialcal items.</div>` : eventCards.map(e => `
      <div class="card">
        <div class="row" style="justify-content: space-between; align-items: baseline;">
          <div><b>${escHtml(e.title)}</b></div>
          <div class="pill">${e.allDay ? "all-day" : "timed"}</div>
        </div>

        <div class="muted time"
             data-allday="${e.allDay ? "true" : "false"}"
             data-start="${escHtml(e.start)}"
             data-end="${escHtml(e.end)}">
        </div>

    <div style="margin-top:10px;"><b>Description:</b></div>
    <div class="desc">${e.descriptionHtml}</div>
      </div>
    `).join("")}
  </div>

  <div class="muted" style="margin-top:24px;">
    Events from <a href="${profileUrl}">Bluesky</a> via <a href="https://socialcal.org/">SocialCal</a>.
  </div>

<script>
(function () {
  const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  for (const el of document.querySelectorAll(".time")) {
    const allDay = el.dataset.allday === "true";
    const s = el.dataset.start || "";
    const e = el.dataset.end || "";

    if (allDay) {
      // Expect YYYY-MM-DD strings (end is exclusive)
      const [sy, sm, sd] = s.split("-").map(Number);
      const [ey, em, ed] = e.split("-").map(Number);
      if (!sy || !sm || !sd || !ey || !em || !ed) { el.textContent = ""; continue; }

      const start = new Date(sy, sm - 1, sd);   // local date, no TZ shift
      const endEx = new Date(ey, em - 1, ed);   // local exclusive end
      const endInclusive = new Date(endEx);
      endInclusive.setDate(endInclusive.getDate() - 1);

      el.textContent = sameDay(start, endInclusive)
        ? fmtDate.format(start)
        : fmtDate.format(start) + " – " + fmtDate.format(endInclusive);

      continue;
    }

    // Timed: expect ISO timestamps
    const start = s ? new Date(s) : null;
    const end = e ? new Date(e) : null;
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
      el.textContent = "";
      continue;
    }

    if (sameDay(start, end)) {
      el.textContent = fmtDate.format(start) + " · " + fmtTime.format(start) + " – " + fmtTime.format(end);
    } else {
      el.textContent =
        fmtDate.format(start) + " " + fmtTime.format(start) +
        " – " +
        fmtDate.format(end) + " " + fmtTime.format(end);
    }
  }
})();
</script>

</body>
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

async function cacheGet(env: Env, handle: string, kind: "ics"): Promise<{ hit: false } | { hit: true; body: string; contentType: string }> {
  const id = env.RATE_LIMITER.idFromName(rateKey(handle));
  const stub = env.RATE_LIMITER.get(id);
  const res = await doFetchJson(stub, "cache/get", { handle: rateKey(handle), kind });
  if (res.status !== 200) return { hit: false };
  const data = await res.json();
  if (!data?.body || !data?.contentType) return { hit: false };
  return { hit: true, body: String(data.body), contentType: String(data.contentType) };
}

async function cachePut(env: Env, handle: string, kind: "ics", body: string, contentType: string, ttlSec: number): Promise<void> {
  const id = env.RATE_LIMITER.idFromName(rateKey(handle));
  const stub = env.RATE_LIMITER.get(id);
  await doFetchJson(stub, "cache/put", { handle: rateKey(handle), kind, body, contentType, ttlSec });
}

// =====================
// Worker entrypoint
// =====================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let url = new URL(request.url);    
    const handle = url.searchParams.get("handle")?.trim();
    if (!handle) return new Response("Missing handle", { status: 400 });

    // /troubleshoot is just an alias for /show with errors=true
    if (url.pathname === "/troubleshoot") {
      url.pathname = "/show";
      url.searchParams.set("errors", "true");
      return Response.redirect(url.toString(), 302);
    }
    
    // Rate limit per handle (shared across /ics and /troubleshoot)
    const rl = await checkRateLimit(env, handle);
    if (!rl.ok) {
      return new Response("Rate limited", {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSec) },
      });
    }

    const { icsTtl, icsMaxAge, icsSwr, defaultDurationMin } = cacheConfig(env);


    if (url.pathname === "/show") {
      const showErrors = url.searchParams.get("errors") === "true";
      try {
	const candidates = await collectCandidates(handle);
	const { derived, skipped } = deriveFromCandidates(handle, candidates, defaultDurationMin);
	const html = troubleshootHTML(handle, derived, skipped, showErrors);
	return new Response(html, {
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

    try {
        const candidates = await collectCandidates(handle);
	const { derived } = deriveFromCandidates(handle, candidates, defaultDurationMin);
	const ics = buildCalendar(handle, derived);

        await cachePut(env, handle, "ics", ics, "text/calendar; charset=utf-8", icsTtl);

        return new Response(ics, {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Cache-Control": `public, max-age=${icsMaxAge}, stale-while-revalidate=${icsSwr}`,
         },
        });

    } catch (err: any) {
      return new Response(`Error fetching from Bluesky: ${err?.message ?? String(err)}`, { status: 502 });
    }
  }
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
      if (kind !== "ics") return new Response("Bad kind", { status: 400 });

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
      if (kind !== "ics") return new Response("Bad kind", { status: 400 });

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
