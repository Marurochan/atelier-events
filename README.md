# atelier-events

Weekly-refreshed JSON feed of Amsterdam art listings (exhibitions, openings, fairs) for the
[Atelier](https://github.com/Marurochan/Atelier) phone app's **Nearby** screen.

- `scrape.mjs` fetches the Amsterdam Art agenda, parses the event tiles deterministically
  (dates resolved in code), and makes one Claude call to enrich each event with an artist
  name and event type. Zero npm dependencies (Node 20+).
- `.github/workflows/scrape.yml` runs it every Monday and commits `scraped-events.json`
  when it changed. Needs one repo secret: `ANTHROPIC_API_KEY`.
- The app fetches the raw file at launch via `EXPO_PUBLIC_SCRAPED_URL`:

```
https://raw.githubusercontent.com/Marurochan/atelier-events/main/scraped-events.json
```

Events are a read-model in the app — never persisted, refreshed each launch, and shown
with an orange "Listing" dot to stay visibly distinct from hand-added data. If a scrape
parses suspiciously few events (markup change), the script exits non-zero and the last
good JSON stays published.
