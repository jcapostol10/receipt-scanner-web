import { NextRequest } from "next/server";
import { extractReceipt, segmentVideoFrames, type FrameGroup } from "@/lib/claude";
import { buildWorkbook } from "@/lib/xlsx";
import { checkRate } from "@/lib/rate-limit";
import type { ScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_BYTES_PER_FRAME = 8 * 1024 * 1024;
const MAX_FRAMES_PER_SOURCE = 30;
const MAX_SOURCES = 20;

type SourceKind = "image" | "video";
type SourceFrames = {
  kind: SourceKind;
  displayName: string;
  frames: { mediaType: string; base64: string }[];
};

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const rate = checkRate(ip);
  if (!rate.ok) {
    return new Response("rate limit exceeded", {
      status: 429,
      headers: { "Retry-After": String(rate.retryAfterSec) },
    });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("invalid form data", { status: 400 });
  }

  const sources = new Map<string, SourceFrames>();
  for (const [key, value] of form.entries()) {
    if (!(value instanceof File)) continue;
    const parsed = parseKey(key);
    if (!parsed) {
      return new Response(`invalid form key: ${key}`, { status: 400 });
    }
    if (value.size > MAX_BYTES_PER_FRAME) {
      return new Response(`frame too large: ${value.name}`, { status: 413 });
    }
    const mediaType = value.type || "image/jpeg";
    if (!mediaType.startsWith("image/")) {
      return new Response(`unsupported type: ${mediaType}`, { status: 415 });
    }
    const buf = Buffer.from(await value.arrayBuffer());
    const existing = sources.get(parsed.id) ?? {
      kind: parsed.kind,
      displayName: parsed.displayName,
      frames: [],
    };
    if (existing.frames.length >= MAX_FRAMES_PER_SOURCE) continue;
    existing.frames.push({ mediaType, base64: buf.toString("base64") });
    sources.set(parsed.id, existing);
  }

  if (sources.size === 0) {
    return new Response("no files received", { status: 400 });
  }
  if (sources.size > MAX_SOURCES) {
    return new Response(`too many sources (max ${MAX_SOURCES})`, { status: 413 });
  }

  const entries = [...sources.values()];
  const resultsBySource = await Promise.all(
    entries.map(async (src): Promise<ScanResult[]> => {
      if (src.kind === "image") {
        return [await runExtraction(src.displayName, src.frames)];
      }
      return runVideo(src);
    }),
  );

  const results = resultsBySource.flat();

  const xlsx = await buildWorkbook(results);
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(new Uint8Array(xlsx), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="receipts-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}

async function runVideo(src: SourceFrames): Promise<ScanResult[]> {
  let groups: FrameGroup[];
  try {
    groups = await segmentVideoFrames(src.frames);
  } catch (e) {
    return [
      {
        sourceName: src.displayName,
        receipt: null,
        error: `segmentation failed: ${(e as Error).message}`,
      },
    ];
  }

  if (groups.length <= 1) {
    const only = groups[0]?.frame_indices ?? src.frames.map((_, i) => i);
    const picked = only.map((i) => src.frames[i]).filter(Boolean);
    return [await runExtraction(src.displayName, picked)];
  }

  return Promise.all(
    groups.map(async (g, i): Promise<ScanResult> => {
      const picked = g.frame_indices.map((idx) => src.frames[idx]).filter(Boolean);
      const label = g.label || `Receipt ${i + 1}`;
      return runExtraction(`${src.displayName} — ${label}`, picked);
    }),
  );
}

async function runExtraction(
  sourceName: string,
  frames: { mediaType: string; base64: string }[],
): Promise<ScanResult> {
  if (frames.length === 0) {
    return { sourceName, receipt: null, error: "no usable frames" };
  }
  try {
    const receipt = await extractReceipt(frames);
    return { sourceName, receipt };
  } catch (e) {
    return { sourceName, receipt: null, error: (e as Error).message };
  }
}

function parseKey(
  key: string,
): { id: string; kind: SourceKind; displayName: string } | null {
  if (!key.startsWith("i:") && !key.startsWith("v:")) return null;
  const kind: SourceKind = key.startsWith("v:") ? "video" : "image";
  const rest = key.slice(2);
  if (!rest) return null;
  const sepIdx = rest.indexOf("_");
  const displayName = sepIdx >= 0 ? rest.slice(sepIdx + 1) : rest;
  return { id: key, kind, displayName: displayName || rest };
}
