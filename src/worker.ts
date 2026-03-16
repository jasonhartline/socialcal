// src/worker.ts

import * as chrono from "chrono-node";
import ical, { ICalCalendar } from "ical-generator";
import { DateTime } from "luxon";
import { RichText } from "@atproto/api";



const BSKY_PUBLIC = "https://public.api.bsky.app/xrpc";
const DEFAULT_RELATIVE_TZ = "America/Los_Angeles";

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
  // Allow "[...]" optionally followed by whitespace + title text (possibly empty)
  const m = line.match(/^\s*\[(.+?)\]\s*(.*?)\s*$/);
  if (!m) return null;
  return { bracket: m[1].trim(), titleRemainder: (m[2] ?? "").trim() };
}

const DEFAULT_TITLE = "SocialCal Event (Unnamed)";

function titleOrDefault(
  parsedTitle: string,
  postUri: string,
  permalink: string | null,
  role: Attribution["role"],
  whenBracket: string
): { title: string; warning?: Diagnostic } {
  const t = (parsedTitle ?? "").trim();
  if (t.length > 0) return { title: t };

  const at: Attribution = {
    postUri,
    permalink,
    role,
    snippetText: `[${whenBracket}]`,         // show the header context we had
    snippetHtml: escHtml(`[${whenBracket}]`),
  };

  return {
    title: DEFAULT_TITLE,
    warning: {
      severity: "warning",
      code: "TITLE_MISSING",
      message: "Missing title after the bracket; using a default title.",
      at,
    },
  };
}

function descriptionMissingWarning(
  postUri: string,
  permalink: string | null,
  role: Attribution["role"],
  snippetText: string
): Diagnostic {
  return {
    severity: "warning",
    code: "DESCRIPTION_MISSING",
    message: "No details were provided; showing footer only.",
    at: {
      postUri,
      permalink,
      role,
      snippetText,
      snippetHtml: escHtml(snippetText),
    },
  };
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



// relative time helpers
function chronoReferenceStartOfDayInZone(referenceISO: string, zone: string): Date {
  const ref = DateTime.fromISO(referenceISO, { zone: "utc" });
  if (!ref.isValid) return new Date(referenceISO);

  if (zone.startsWith("OFFSET")) {
    const m = zone.match(/^OFFSET([+-])(\d{2}):(\d{2})$/);
    if (!m) return new Date(referenceISO);

    const sign = m[1] === "-" ? -1 : 1;
    const minutes = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));

    return ref
      .plus({ minutes })
      .startOf("day")
      .minus({ minutes })
      .toJSDate();
  }

  const z = ref.setZone(zone);
  if (!z.isValid) return new Date(referenceISO);
  return z.startOf("day").toJSDate();
}

function looksRelativeDateExpr(expr: string): boolean {
  const s = expr.trim().toLowerCase();

  if (/\b(today|tomorrow|tonight|this\s+\w+|next\s+\w+)\b/.test(s)) return true;

  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(s)) return true;
  if (/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.test(s)) return true;

  return false;
}

function chooseChronoReference(
  bracket: string,
  referenceISO: string
): { expr: string; zoneForTimed: string | null; reference: Date } {
  const tz = parseTimezoneToken(bracket);

  if (tz) {
    return {
      expr: tz.expr,
      zoneForTimed: tz.zone,
      reference: chronoReferenceStartOfDayInZone(referenceISO, tz.zone),
    };
  }

  const expr = bracket.trim();

  if (looksRelativeDateExpr(expr)) {
    return {
      expr,
      zoneForTimed: null,
      reference: chronoReferenceStartOfDayInZone(referenceISO, DEFAULT_RELATIVE_TZ),
    };
  }

  return {
    expr,
    zoneForTimed: null,
    reference: new Date(referenceISO),
  };
}



type WhenParseResult =
  | { when: WhenSpec; error?: undefined }
  | { when: null; error: Diagnostic };


function parseWhenSpecResult(
  bracket: string,
  titleForContext: string,
  referenceISO: string,
  defaultDurationMin: number,
  postUri: string,
  permalink: string | null,
  role: Attribution["role"]
): WhenParseResult {
  const raw = bracket.trim();

  const chosen = chooseChronoReference(raw, referenceISO);
  const expr = chosen.expr;
  const reference = chosen.reference;

  const results = chrono.parse(expr, reference, { forwardDate: true });
  if (!results?.length) {
    return {
      when: null,
      error: {
        severity: "error",
        code: "WHEN_UNPARSABLE",
        message: "Could not parse the date/time in the bracket.",
        at: makeWhenAttribution(postUri, permalink, role, bracket, titleForContext),
      },
    };
  }

  const r = results[0];
  const s = r.start;
  const startHasHour = s.isCertain("hour") || s.isCertain("minute");

  // ---- ALL-DAY
  if (!startHasHour) {
    const sy = s.get("year");
    const sm = s.get("month");
    const sd = s.get("day");

    if (r.end) {
      const e = r.end;
      const ey = e.get("year");
      const em = e.get("month");
      const ed = e.get("day");

      return {
        when: {
          kind: "allday",
          startDate: { y: sy, m: sm, d: sd },
          endDateExclusive: addDaysUTC(ey, em, ed, 1),
        },
      };
    }

    return {
      when: {
        kind: "allday",
        startDate: { y: sy, m: sm, d: sd },
        endDateExclusive: addDaysUTC(sy, sm, sd, 1),
      },
    };
  }

  // ---- TIMED: timezone always required
  const tz = parseTimezoneTokenDetailed(bracket);
  if (!tz.ok) {
    if (tz.kind === "missing") {
      return {
        when: null,
        error: {
          severity: "error",
          code: "WHEN_MISSING_TIMEZONE",
          message:
            "Timed events must include a timezone at the end of the bracket (e.g., 'PT', 'ET', 'America/Chicago', 'Z', or '+01:00').",
          at: makeWhenAttribution(postUri, permalink, role, bracket, titleForContext),
        },
      };
    }

    if (tz.kind === "unsupported") {
      return {
        when: null,
        error: {
          severity: "error",
          code: "WHEN_UNSUPPORTED_TIMEZONE",
          message:
            `Unsupported timezone '${tz.tzToken}'. Supported: ET/CT/MT/PT, IANA zones like 'America/Chicago', 'Z', or offsets like '+01:00'.`,
          at: makeWhenAttribution(postUri, permalink, role, bracket, titleForContext, tz.tzToken),
        },
      };
    }

    return {
      when: null,
      error: {
        severity: "error",
        code: "WHEN_INVALID_TIMEZONE",
        message: `Malformed timezone token '${tz.tzToken}'.`,
        at: makeWhenAttribution(postUri, permalink, role, bracket, titleForContext, tz.tzToken),
      },
    };
  }

  const sh = s.get("hour");
  const smin = s.isCertain("minute") ? s.get("minute") : 0;
  const ss = s.isCertain("second") ? s.get("second") : 0;

  const sBase = DateTime.fromObject(
    {
      year: s.get("year"),
      month: s.get("month"),
      day: s.get("day"),
      hour: sh,
      minute: smin,
      second: ss,
    },
    { zone: "UTC" }
  );

  const startZ = applyZone(sBase, tz.zone);
  if (!startZ || !startZ.isValid) {
    return {
      when: null,
      error: {
        severity: "error",
        code: "WHEN_INVALID_TIMEZONE",
        message: `Could not interpret timezone '${tz.tzToken}' for this date/time.`,
        at: makeWhenAttribution(postUri, permalink, role, bracket, titleForContext, tz.tzToken),
      },
    };
  }

  let endZ: DateTime;

  if (r.end) {
    const e = r.end;

    const eh = e.isCertain("hour") ? e.get("hour") : sh;
    const emin = e.isCertain("minute") ? e.get("minute") : 0;
    const esec = e.isCertain("second") ? e.get("second") : 0;

    const ey = e.isCertain("year") ? e.get("year") : s.get("year");
    const em = e.isCertain("month") ? e.get("month") : s.get("month");
    const ed = e.isCertain("day") ? e.get("day") : s.get("day");

    const eBase = DateTime.fromObject(
      {
        year: ey,
        month: em,
        day: ed,
        hour: eh,
        minute: emin,
        second: esec,
      },
      { zone: "UTC" }
    );

    const ez = applyZone(eBase, tz.zone);
    if (!ez || !ez.isValid) {
      return {
        when: null,
        error: {
          severity: "error",
          code: "WHEN_INVALID_TIMEZONE",
          message: `Could not interpret timezone '${tz.tzToken}' for this date/time.`,
          at: makeWhenAttribution(postUri, permalink, role, bracket, titleForContext, tz.tzToken),
        },
      };
    }

    endZ = ez;
  } else {
    endZ = startZ.plus({ minutes: defaultDurationMin });
  }

  if (endZ <= startZ) {
    endZ = startZ.plus({ minutes: defaultDurationMin });
  }

  return {
    when: {
      kind: "timed",
      start: startZ,
      end: endZ,
    },
  };
}


function looksLikeTimezoneToken(tok: string): boolean {
  if (!tok) return false;
  if (US_TZ_MAP[tok]) return true;
  if (tok === "Z") return true;
  if (/^[+-]\d{2}:\d{2}$/.test(tok)) return true;
  if (/^[A-Za-z]+\/[A-Za-z_]+$/.test(tok)) return true;      // IANA-ish
  if (/^[A-Za-z]{2,5}$/.test(tok)) return true;              // e.g. PST/EST/UTC
  return false;
}

type TzParseOk = { ok: true; expr: string; zone: string; tzToken: string };
type TzParseErr =
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "unsupported"; tzToken: string }
  | { ok: false; kind: "malformed"; tzToken: string };

function parseTimezoneTokenDetailed(bracket: string): TzParseOk | TzParseErr {
  const raw = bracket.trim();
  const tokens = raw.split(/\s+/);
  if (tokens.length < 2) {
    // might still be missing tz (e.g. "March 10 10am")
    return { ok: false, kind: "missing" };
  }

  const tzToken = tokens[tokens.length - 1];
  const expr = tokens.slice(0, -1).join(" ").trim();
  if (!expr) return { ok: false, kind: "malformed", tzToken };

  // If last token doesn't even look like TZ, treat as missing (timed rule)
  if (!looksLikeTimezoneToken(tzToken)) return { ok: false, kind: "missing" };

  // Supported short forms
  if (US_TZ_MAP[tzToken]) return { ok: true, expr, zone: US_TZ_MAP[tzToken], tzToken };

  // Supported IANA
  if (/^[A-Za-z]+\/[A-Za-z_]+$/.test(tzToken)) return { ok: true, expr, zone: tzToken, tzToken };

  // Supported Z / offsets
  if (tzToken === "Z") return { ok: true, expr, zone: "UTC", tzToken };
  if (/^[+-]\d{2}:\d{2}$/.test(tzToken)) return { ok: true, expr, zone: `OFFSET${tzToken}`, tzToken };

  // Looks like TZ but not supported
  return { ok: false, kind: "unsupported", tzToken };
}


function headerSnippetText(whenBracket: string, title: string): string {
  const t = (title ?? "").trim();
  return t ? `[${whenBracket}] ${t}` : `[${whenBracket}]`;
}

function makeWhenAttribution(
  postUri: string,
  permalink: string | null,
  role: Attribution["role"],
  whenBracket: string,
  title: string,
  highlightToken?: string
): Attribution {
  const snippetText = headerSnippetText(whenBracket, title);
  // For now, snippetHtml is just escaped text. Later we can upgrade to facet-aware.
  const snippetHtml = escHtml(snippetText);

  let highlight: Highlight | undefined;
  if (highlightToken) {
    const idx = snippetText.lastIndexOf(highlightToken);
    if (idx >= 0) highlight = { kind: "char", start: idx, end: idx + highlightToken.length };
  }

  return { postUri, permalink, role, snippetText, snippetHtml, highlight };
}

// For all-day, build UTC-midnight JS Dates
function utcMidnightDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}

function escHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
type CandidateEvent = | {
  kind: "full";
  sourceUri: string;
  sourceHandle?: string;
    whenBracket: string;
  title: string;
  details: string;
  detailsHtml: string;
  referenceISO: string;
  sources: SourcePost[];
} | {
  kind: "combo";
  sourceUri: string;
  detailsUri: string;
  sourceHandle?: string;
  whenBracket: string;
  title: string;
  details: string;
  detailsHtml: string;
  referenceISO: string;
  sources: SourcePost[];
};
    

function eventKey(e: CandidateEvent): string {
  return e.kind === "full" ? `full:${e.sourceUri}` : `combo:${e.sourceUri}->${e.detailsUri}`;
}


type Highlight = { kind: "char"; start: number; end: number };

type Attribution = {
  postUri: string;          // at://...
  permalink: string | null; // bsky.app link
  role: "full" | "reply-header" | "reply-parent" | "unknown";
  snippetText: string;      // facet-rendered plain text snippet
  snippetHtml: string;      // facet-rendered html snippet
  highlight?: Highlight;    // optional [start,end) into snippetText/snippetHtml (char-based)
};

type Diagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  at?: Attribution;
};

type SourcePost = {
  role: "full" | "reply-header" | "reply-parent" | "thread";
  uri: string;                 // at://...
  permalink: string | null;    // bsky.app link (if we can make one)
  authorHandle: string | null; // for display
  createdAt: string | null;    // optional
  text: string;                // facet-canonical plain
  html: string;                // facet-canonical html
};

type DerivedEvent = {
  uid: string;
  title: string;
  when: WhenSpec | null; 
  permalink: string | null;
  description: string;
  descriptionHtml: string;

  sources: SourcePost[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
};



function candidateUid(e: CandidateEvent): string {
  if (e.kind === "full") return e.sourceUri;
  return e.detailsUri; // canonical for combo
}

function candidatePermalink(e: CandidateEvent): string | null {
  return toBskyPermalink(e.sourceHandle, e.sourceUri);
}

function handleFromPermalink(url: string): string | null {
  const m = url.match(/\/profile\/([^/]+)\/post\//);
  return m ? m[1] : null;
}


function buildEventDescriptionHtml(detailsHtml: string, permalink: string, handle: string): string {
  const d = (detailsHtml ?? "").trim();

  //  const blueskyProfile = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
  const postHandle = handleFromPermalink(permalink);
  const socialcalShow = `https://socialcal.org/show?handle=${encodeURIComponent(handle)}`;

  const footer = `From Bluesky <a href="${escHtml(permalink)}" target="_blank" rel="noopener noreferrer">@${escHtml(postHandle || "unknown")}</a>\n` +
                 `via SocialCal <a href="${socialcalShow}" target="_blank" rel="noopener noreferrer">${escHtml(socialcalShow)}</a>`;

  return [d, footer].filter((x) => x && x.trim().length > 0).join("\n\n");
}

function buildEventDescription(details: string, permalink: string, handle: string): string {
  const d = (details ?? "").trim();

//  const blueskyProfile = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
  const socialcalShow = `https://socialcal.org/show?handle=${encodeURIComponent(handle)}`;

  const footer = `From Bluesky ${escHtml(permalink)}\nvia SocialCal ${socialcalShow}`;

  return [d, footer].filter((x) => x && x.trim().length > 0).join("\n\n");
}

function sourceFromPost(p: PostView, role: SourcePost["role"]): SourcePost {
  const parts = getPostTextParts(p); // your facet-based render
  return {
    role,
    uri: p.uri,
    permalink: toBskyPermalink(p.author?.handle, p.uri),
    authorHandle: p.author?.handle ?? null,
    createdAt: String(p?.record?.createdAt ?? p?.indexedAt ?? "") || null,
    text: parts.text,
    html: parts.html,
  };
}

function deriveFromCandidates(handle: string, events: CandidateEvent[], defaultDurationMin: number): { derived: DerivedEvent[] } {

  const derived: DerivedEvent[] = [];

  for (const e of events) {

    const permalink = candidatePermalink(e);
    const uid = candidateUid(e);

    // choose the post URI to attribute the when parse to
    const role: Attribution["role"] = e.kind === "full" ? "full" : "reply-header";

    // check title
    const tRes = titleOrDefault(e.title, e.sourceUri, permalink, role, e.whenBracket);
    const titleWarnings = tRes.warning ? [tRes.warning] : [];


    // check description
    const detailsMissing = (e.details ?? "").trim() === "";
    const descWarnings = detailsMissing
	  ? [descriptionMissingWarning(detailsPostUri, permalink, detailsRole, "")]
	  : [];
    
    // check when
    const wr = parseWhenSpecResult(
      e.whenBracket,
      tRes.title,
      e.referenceISO,
      defaultDurationMin,
      e.sourceUri,
      permalink,
      role
    );
    const whenErrors = (wr.error) ? [wr.error] : [];
    
    derived.push({
      uid,
      title: tRes.title,
      when: wr.when,
      permalink,
      description: buildEventDescription(e.details, permalink, handle),
      descriptionHtml: buildEventDescriptionHtml(e.detailsHtml, permalink, handle),
      errors: whenErrors,
      warnings: [...titleWarnings, ...descWarnings],
      sources: e.sources
    });
    
  }

  return { derived };
}


function buildEventFromFullPost(p: PostView): CandidateEvent | null {
  const ex = extractFullEventDetailsParts(p);
  if (!ex) return null;

  return {
    kind: "full",
    sourceUri: p.uri,
    sourceHandle: p.author?.handle,
    whenBracket: ex.when,
    title: ex.title,              // may now be empty
    details: ex.detailsText,
    detailsHtml: ex.detailsHtml,
    referenceISO: getPostCreatedAt(p),
    sources: [sourceFromPost(p, "full")],
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
    sourceUri: headerPost.uri,
    detailsUri: detailsPost.uri,
    sourceHandle: headerPost.author?.handle,
    whenBracket: hdr.when,
    title: hdr.title,
    details,
    detailsHtml,
    referenceISO: getPostCreatedAt(headerPost),
    sources: [
      sourceFromPost(detailsPost, "reply-parent"),
      sourceFromPost(headerPost, "reply-header"),
  ],
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
    if (e.errors.length > 0) continue; // don't add error events.
    if (!e.when) continue;             // skip invalid events. (should not get here)

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


function eventSortKey(e: DerivedEvent): { hasError: number; hasWhen: number; t: number } {
  const hasError = (e.errors?.length ?? 0) > 0 ? 0 : 1;   // 0 first
  const hasWhen = e.when ? 1 : 0;                         // 0 (null) first
  const t =
    e.when?.kind === "timed"
      ? e.when.start.toMillis()
      : e.when?.kind === "allday"
        ? DateTime.utc(e.when.startDate.y, e.when.startDate.m, e.when.startDate.d).toMillis()
        : 0; // null when => tie-breaker at top of error section
  return { hasError, hasWhen, t };
}

function sortEventsForShow(events: DerivedEvent[]): DerivedEvent[] {
  return [...events].sort((a, b) => {
    const A = eventSortKey(a), B = eventSortKey(b);
    if (A.hasError !== B.hasError) return A.hasError - B.hasError;
    if (A.hasWhen !== B.hasWhen) return A.hasWhen - B.hasWhen;
    return A.t - B.t;
  });
}


function troubleshootHTML(handle: string, events: DerivedEvent[], showAll: boolean, showErrors: boolean): string {
  const profileUrl = `https://bsky.app/profile/${encodeURIComponent(handle)}`;

  const baseShowUrl = `/show?handle=${encodeURIComponent(handle)}`;
  const upcomingUrl = showErrors ? `${baseShowUrl}&errors=true` : baseShowUrl;
  const allUrl = showErrors ? `${baseShowUrl}&all=true&errors=true` : `${baseShowUrl}&all=true`;

  const sorted = showErrors
	? sortEventsForShow(events)
	: sortEventsForShow(events.filter(e => (e.errors?.length ?? 0) === 0));
  
  const eventCards = sorted.map((e) => {     
    let card = {
      title: e.title,
      timeKind: "error",
      start: "", 
      end: "", 
      description: e.description,
      descriptionHtml: e.descriptionHtml,
      errors: e.errors ?? [],
      warnings: e.warnings ?? [],
      attributions: [
	...(e.errors ?? []).map(d => d.at).filter(Boolean),
	...(e.warnings ?? []).map(d => d.at).filter(Boolean),
      ] as Attribution[],
      sources: e.sources ?? [],
    };
    
    if (!e.when) { return card; }

    card.timeKind = e.when.kind;
    
    if (card.timeKind === "allday") {
      card.start = DateTime.utc(e.when.startDate.y, e.when.startDate.m, e.when.startDate.d).toISODate() ?? "";
      card.end = DateTime.utc(e.when.endDateExclusive.y, e.when.endDateExclusive.m, e.when.endDateExclusive.d).toISODate() ?? "";
      return card;
    }
    
    card.start = e.when.start.toISO() ?? "";
    card.end =  e.when.end.toISO() ?? "";
    
    return card;
      
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
  .card.error {
    border-color: #f2b8b5;
    background: #fff5f5;
  }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #f1f1f1; }
  .desc {
    white-space: pre-wrap;
    word-break: break-word;
background: #f7f7f7; padding: 10px; border-radius: 8px; 
  }
.context-header {
  margin-bottom: 4px;
}

  .postlist { display: grid; gap: 8px; }
  .postcard { border: 1px solid #e6e6e6; border-radius: 12px; padding: 10px 12px; background: #fff; }
  .posthdr { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; margin-bottom: 6px; }
  .postrole { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #f1f1f1; }
  .postmeta { font-size: 13px; color: #555; }
  .postbody { line-height: 1.35; }
  .postbody a { text-decoration: none; }
  .postbody a:hover { text-decoration: underline; }
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
.diagnostics {
  margin-top: 8px;
  display: grid;
  gap: 6px;
}
  .diag-header {
    font-weight: 600;
    margin-top: 4px;
  }

  .error-header { color: #842029; }
  .warning-header { color: #664d03; }

  .diag { padding: 8px 10px; border-radius: 8px; }

  .diag-error { background: #f8d7da; color: #842029; }
  .diag-warning { background: #fff3cd; color: #664d03; }

  .contextbox {
    margin-top: 6px;
    padding: 10px;
    border-radius: 12px;
    background: #f7f7f7;
    border: 1px solid #e6e6e6;
  }

  .context-header {
    color: #444;
    font-weight: 600;
    margin-bottom: 4px;
  }
</style>
</head>
<body>
  <h1>SocialCal</h1>
  <div class="muted"><a href="${profileUrl}">@${escHtml(handle)}</a></div>
<div class="muted" style="margin-top:6px;">
  ${showAll
    ? `<a href="${upcomingUrl}">Today onward</a> · <b>All posts</b>`
    : `<b>Today onward</b> · <a href="${allUrl}">All posts</a>`}
</div>



  <div class="grid">
    ${eventCards.length === 0 ? `<div class="muted">No events parsed from recent #socialcal items.</div>` : eventCards.map(e => `
    <div class="card ${e.errors.length ? "error" : ""}"
      data-event-card="true"
      data-has-errors="${e.errors.length ? "true" : "false"}"
      data-time-kind="${escHtml(e.timeKind)}"
      data-start="${escHtml(e.start)}"
      data-end="${escHtml(e.end)}" >
        <div class="row" style="justify-content: space-between; align-items: baseline;">
          <div><b>${escHtml(e.title)}</b></div>
          <div class="pill">${e.timeKind}</div>
        </div>

  <div class="muted time"
     ${e.timeKind !== "error" ? `
       data-allday="${e.timeKind === "allday" ? "true" : "false"}"
       data-start="${escHtml(e.start)}"
       data-end="${escHtml(e.end)}"
     ` : ""}>
    ${e.timeKind === "error" ? "Could not parse date/time" : ""}
  </div>

  ${showErrors && (e.errors.length || e.warnings.length) ? `
  <div class="diagnostics">

    ${e.errors.length ? `
    <div class="diag-header error-header">Error:</div>
      ${e.errors.map(err => `
        <div class="diag diag-error">
          ${escHtml(err.message)}
        </div>
      `).join("")}
    ` : ""}

    ${e.warnings.length ? `
    <div class="diag-header warning-header">Warning:</div>
      ${e.warnings.map(warn => `
        <div class="diag diag-warning">
          ${escHtml(warn.message)}
        </div>
      `).join("")}
    ` : ""}

  <div class="context-header">
    Relevant post${(e.sources?.length ?? 0) > 1 ? "s" : ""}:
  </div>

    <div class="postlist">
      ${(e.sources ?? []).map(p => `
        <div class="postcard">
          <div class="posthdr">
            <div class="postmeta">
              <b>${escHtml(p.authorHandle ?? "unknown")}</b>
              ${p.permalink ? ` · <a href="${escHtml(p.permalink)}" target="_blank" rel="noopener noreferrer">View on Bluesky</a>` : ``}
            </div>
            <div class="postrole">${escHtml(p.role)}</div>
          </div>
          <div class="postbody">${p.html}</div>
        </div>
      `).join("")}
    </div>

  </div>
` : ""}
  
  
    <div style="margin-top:10px;"><b>Description:</b></div>
    <div class="desc">${e.descriptionHtml}</div>
      </div>
    `).join("")}
  </div>

  <div class="muted" style="margin-top:24px;">
    Events from <a href="${profileUrl}">Bluesky</a> via <a href="https://socialcal.org/">SocialCal</a>.
  </div>

<script>
const SOCIALCAL_SHOW_ALL = ${showAll ? "true" : "false"};
</script>
<script>
(function () {
  const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function startOfTodayLocal() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function twelveHoursAgo() {
    return new Date(Date.now() - 12 * 60 * 60 * 1000);
  }

  function isVisibleCard(card) {
    if (SOCIALCAL_SHOW_ALL) return true;

    const hasErrors = card.dataset.hasErrors === "true";
    if (hasErrors) return true;

    const kind = card.dataset.timeKind || "";
    const start = card.dataset.start || "";
    const end = card.dataset.end || "";

    if (kind === "timed") {
      const endDt = end ? new Date(end) : null;
      if (!endDt || isNaN(endDt.getTime())) return true;
      return endDt >= twelveHoursAgo();
    }

    if (kind === "allday") {
      // end is exclusive YYYY-MM-DD
      const [ey, em, ed] = end.split("-").map(Number);
      if (!ey || !em || !ed) return true;
      const endExclusive = new Date(ey, em - 1, ed);
      return endExclusive > startOfTodayLocal();
    }

    return true;
  }

  for (const el of document.querySelectorAll(".time")) {
    const allDay = el.dataset.allday === "true";
    const s = el.dataset.start || "";
    const e = el.dataset.end || "";

    if (allDay) {
      const [sy, sm, sd] = s.split("-").map(Number);
      const [ey, em, ed] = e.split("-").map(Number);
      if (!sy || !sm || !sd || !ey || !em || !ed) { el.textContent = ""; continue; }

      const start = new Date(sy, sm - 1, sd);
      const endEx = new Date(ey, em - 1, ed);
      const endInclusive = new Date(endEx);
      endInclusive.setDate(endInclusive.getDate() - 1);

      el.textContent = sameDay(start, endInclusive)
        ? fmtDate.format(start)
        : fmtDate.format(start) + " – " + fmtDate.format(endInclusive);

      continue;
    }

    const start = s ? new Date(s) : null;
    const end = e ? new Date(e) : null;
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
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

  for (const card of document.querySelectorAll('[data-event-card="true"]')) {
    if (!isVisibleCard(card)) {
      card.style.display = "none";
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
      const showAll = url.searchParams.get("all") === "true";
      try {
	const candidates = await collectCandidates(handle);
	const { derived } = deriveFromCandidates(handle, candidates, defaultDurationMin);
	const html = troubleshootHTML(handle, derived, showAll, showErrors);
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
