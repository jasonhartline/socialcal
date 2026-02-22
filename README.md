# SocialCal

Passive **Bluesky → ICS** calendar feed generator.

SocialCal extracts structured events from Bluesky posts containing `#socialcal` and exposes them as a standard iCalendar (`.ics`) feed suitable for Google Calendar, Apple Calendar, Outlook, etc.

**Live:** https://socialcal.org  

**ICS endpoint:**
```
https://socialcal.org/ics?handle=<bluesky-handle>
```

**Troubleshoot endpoint:**
```
https://socialcal.org/troubleshoot?handle=<bluesky-handle>
```

---

## Overview

SocialCal is designed to be:

- Passive (pull-based ICS only)
- Deterministic
- Timezone-correct
- Thread-aware
- RFC 5545 compliant
- Architecturally clean (parse once, render many)

It does not push to calendars and does not store user accounts.

---

## Architecture

**Hosting**
- Cloudflare Workers (API)
- Cloudflare Pages (docs site)
- Domain: socialcal.org

**Language**
- TypeScript

**Core Libraries**
- `chrono-node` – human-readable date parsing
- `luxon` – timezone handling
- `ical-generator` – ICS generation

**State**
- Durable Object for:
  - Rate limiting
  - Caching

---

## Event Format

SocialCal extracts events from posts containing:

```
#socialcal
```

### Full Event Post

```
[date/time TZ] Title

Details text #socialcal
```

Example:

```
[March 10 10:30am-12pm CT] Lab Meeting

Room 2405 Tech. #socialcal
```

---

## Reply Semantics

Thread traversal is supported.

If a reply contains `#socialcal`:

1. If parent is a full event → use parent.
2. If reply contains a header:
   ```
   [date] title #socialcal
   ```
   → Parent provides details.
3. If hashtag-only reply → bind to nearest ancestor header.

Thread root determines event sort order.

Duplicate posts in a thread are deduplicated.

---

## Date Handling Rules

Parsing is performed using `chrono-node`.

### Timed Events

Must include explicit timezone:

- ET / CT / MT / PT
- IANA zone (e.g., America/Chicago)
- `Z`
- `±HH:MM`

Timed events retain timezone information and are passed to `ical-generator` as Luxon `DateTime` objects.

No JS `Date` conversion for timed events.

---

### All-Day Events

- Date-only → all-day
- Encoded as UTC midnight JS `Date`
- Date ranges (e.g., `[March 3-5]`) are inclusive
- Internally encoded with exclusive `DTEND` per RFC 5545

---

### Time Ranges

For:

```
10:30am-6pm
```

End date inherits start date unless explicitly specified.

This prevents chrono from incorrectly jumping forward one week.

---

## ICS Output

- RFC 5545 compliant
- `REFRESH-INTERVAL` set via:
  ```
  cal.ttl(3600)
  ```
- Description footer appended:

```
Source: <permalink> · via SocialCal https://socialcal.org/
```

---

## Troubleshoot Mode

The `/troubleshoot` endpoint:

- Uses identical derived event data as `/ics`
- Displays:
  - Parsed start/end
  - All-day vs timed
  - Skipped items with reason
  - Multi-day handling
- Avoids UTC shift bug in date-only formatting

No duplicated parsing logic exists between ICS and troubleshoot.

---

## Invariants

The following are strict architectural guarantees:

- Parsing happens once.
- Rendering layers do not mutate dates.
- ICS and troubleshoot consume identical derived data.
- Timed events retain timezone.
- All-day events are timezone-neutral.
- No duplicate events across thread traversal.
- Thread root determines sort order.

---

## Design Philosophy

SocialCal intentionally:

- Does not require OAuth
- Does not store user events
- Does not push to calendars
- Does not attempt bidirectional sync

It is a pure transformation layer:

```
Bluesky → Normalized Thread → DerivedEvent[] → Renderer
```

Correctness > convenience.  
Determinism > clever hacks.

---

## Limitations

- Calendar refresh timing is controlled by the client (e.g., Google Calendar).
- Bluesky API availability may affect feed freshness.
- Only posts containing `#socialcal` are considered.

---

## Development

Install dependencies:

```
npm install
```

Run locally:

```
npx wrangler dev
```

Deploy:

```
npx wrangler deploy
```

---

## License

MIT License

Copyright (c) SocialCal contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.