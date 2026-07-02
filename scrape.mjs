/* ============================================================
   scrape.mjs — Amsterdam art listings → scraped-events.json
   Runs weekly in GitHub Actions (see .github/workflows/scrape.yml).
   Feeds the Atelier app: the app fetches the committed JSON via
   EXPO_PUBLIC_SCRAPED_URL (raw.githubusercontent.com) and merges it
   as a read-model (source:'scraped', orange dot).

   Pipeline:
   1. Fetch the Amsterdam Art agenda (one page = the whole scene).
   2. Parse event tiles deterministically (regex over stable markup);
      dates resolved to ISO in code (year inferred from today).
   3. One Claude call enriches artist + event type. If it fails,
      the feed still publishes with safe defaults — never breaks.

   Zero npm deps (Node 20+ built-in fetch). Claude via raw fetch to
   the Messages API — same idiom as the app (no SDK; it won't bundle
   in Metro, and here it keeps CI dependency-free).
   ============================================================ */

import { writeFileSync } from 'node:fs';

const AGENDA_URL = 'https://amsterdamart.com/en/agenda/';
const OUT_FILE = new URL('./scraped-events.json', import.meta.url);
const MODEL = 'claude-opus-4-8';
const MIN_EVENTS = 5; // fewer than this = markup changed; fail loudly, keep last good JSON

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- tiny helpers ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function slug(s, max = 28) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** "3 Jul" (+ today's date) → "2026-07-03". The page omits the year, so we
    infer it: a date more than ~3 months in the past belongs to next year. */
function resolveDate(day, monName, today) {
  const month = MONTHS[monName.slice(0, 3).toLowerCase()];
  if (!month) return null;
  let year = today.getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const threeMonthsAgo = new Date(today.getTime() - 92 * 24 * 3600 * 1000);
  if (candidate < threeMonthsAgo) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ---------- 1. fetch ----------

const res = await fetch(AGENDA_URL, { headers: { 'User-Agent': UA } });
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const html = await res.text();

// ---------- 2. deterministic parse ----------

const today = new Date();
const tiles = html.match(/<article class="art-ahead-event-tile">[\s\S]*?<\/article>/g) ?? [];
const events = [];
const seenIds = new Set();

for (const tile of tiles) {
  const href = tile.match(/<a href="([^"]+)"/)?.[1];
  const venue = tile.match(/class="art-ahead-event-tile-venue">([^<]*)</)?.[1];
  const title = tile.match(/<h3>([\s\S]*?)<\/h3>/)?.[1];
  const meta = tile.match(/class="art-ahead-event-tile-meta">([^<]*)</)?.[1];
  if (!title || !venue) continue;

  // meta variants: "3 Jul — Amsterdam" · "3 Jul up to 14 Aug — Amsterdam"
  //              · "10 up to 11 Jul — Amsterdam" (same-month range, month written once)
  const metaStr = decodeEntities(meta ?? '');
  let m = metaStr.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+up to\s+\d{1,2}\s+[A-Za-z]{3,})?\s*[—–-]\s*(.+)$/);
  if (!m) m = metaStr.match(/^(\d{1,2})\s+up to\s+\d{1,2}\s+([A-Za-z]{3,})\s*[—–-]\s*(.+)$/);
  const date = m ? resolveDate(Number(m[1]), m[2], today) : null;
  const loc = m ? m[3].trim() : 'Amsterdam';

  let id = `scr-${slug(decodeEntities(venue), 16)}-${slug(decodeEntities(title), 24)}`;
  while (seenIds.has(id)) id += 'x';
  seenIds.add(id);

  events.push({
    id,
    title: decodeEntities(title),
    artist: null, // enriched by Claude below
    venue: decodeEntities(venue),
    loc,
    type: 'exhibition', // enriched by Claude below
    date,
    url: href ?? AGENDA_URL,
  });
}

console.log(`Parsed ${events.length} events from ${tiles.length} tiles.`);
if (events.length < MIN_EVENTS) {
  console.error(`Only ${events.length} events parsed — page markup likely changed. Refusing to publish.`);
  process.exit(1);
}

// ---------- 3. Claude enrichment (artist + type) ----------

const TYPES = ['exhibition', 'opening', 'fair', 'event', 'live-paint'];

async function enrich(list) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const payload = list.map((e, i) => ({ i, title: e.title, venue: e.venue }));
  const schema = {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer' },
            artist: { type: ['string', 'null'] },
            type: { type: 'string', enum: TYPES },
          },
          required: ['i', 'artist', 'type'],
          additionalProperties: false,
        },
      },
    },
    required: ['events'],
    additionalProperties: false,
  };

  const body = {
    model: MODEL,
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content:
          'These are visual-art listings scraped from an Amsterdam gallery/museum agenda. For each item, return:\n' +
          '- artist: the artist’s name ONLY when the title clearly names a specific artist (e.g. a solo show titled with a person’s name, or "Name — Work"). Group shows, thematic titles, or any doubt → null. Never invent a name.\n' +
          '- type: one of ' + TYPES.join(', ') + '. Default to "exhibition"; use "fair" for art fairs, "opening" only when the listing is specifically an opening/vernissage, "event" for talks/performances/screenings.\n\n' +
          'Return every item, keyed by its index i.\n\n' +
          JSON.stringify(payload),
      },
    ],
    output_config: { format: { type: 'json_schema', schema } },
  };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const msg = await r.json();
  if (msg.stop_reason === 'refusal') throw new Error('Claude refused the request');
  const text = msg.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('No text block in Claude response');
  return JSON.parse(text).events;
}

try {
  const enriched = await enrich(events);
  let applied = 0;
  for (const row of enriched) {
    const e = events[row.i];
    if (!e) continue;
    if (row.artist) e.artist = row.artist;
    if (TYPES.includes(row.type)) e.type = row.type;
    applied++;
  }
  console.log(`Claude enriched ${applied}/${events.length} events.`);
} catch (err) {
  // Feed must never break on an AI hiccup: publish with safe defaults.
  console.warn(`Enrichment skipped (${err.message}). Publishing with defaults.`);
  for (const e of events) if (/\b(un)?fair\b/i.test(e.title)) e.type = 'fair';
}

// ---------- 4. write ----------

const out = {
  source: 'amsterdam-art-agenda (weekly GitHub Action)',
  generatedAt: today.toISOString().slice(0, 10),
  events,
};
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${events.length} events to scraped-events.json`);
