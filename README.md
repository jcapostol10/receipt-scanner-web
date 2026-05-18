# receipt-scanner-web

Upload photos or videos of receipts, get back an Excel sheet with the line items.

- **Stack:** Next.js 16 (App Router) on Vercel
- **OCR:** Claude API vision (Sonnet 4.6)
- **Storage:** none — everything is processed in memory and discarded
- **Output:** one `.xlsx` with a sheet per receipt + a Summary sheet

## Run locally

```bash
cp .env.local.example .env.local   # add ANTHROPIC_API_KEY
pnpm install
pnpm dev
```

Open http://localhost:3000.

## How it works

1. Browser accepts images and videos via drag-drop.
2. For videos, the browser extracts ~1 frame/sec via `<canvas>` and dedupes near-duplicates with a perceptual hash.
3. Frames are sent to `/api/scan` as a multipart form.
4. The server calls Claude vision with the frames for each receipt, parses strict JSON, builds an xlsx with `exceljs`, and streams it back.

## Deploy

Linked to Vercel. `ANTHROPIC_API_KEY` is set as an env var on the Vercel project.
