import { NextRequest } from "next/server";
import { extractReceipt } from "@/lib/claude";
import { buildWorkbook } from "@/lib/xlsx";
import { checkRate } from "@/lib/rate-limit";
import type { ScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_BYTES_PER_FRAME = 8 * 1024 * 1024;
const MAX_FRAMES_PER_RECEIPT = 12;
const MAX_RECEIPTS = 20;

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

  const groups = new Map<string, { name: string; mediaType: string; base64: string }[]>();
  for (const [key, value] of form.entries()) {
    if (!(value instanceof File)) continue;
    const groupName = key;
    if (value.size > MAX_BYTES_PER_FRAME) {
      return new Response(`frame too large: ${value.name}`, { status: 413 });
    }
    const mediaType = value.type || "image/jpeg";
    if (!mediaType.startsWith("image/")) {
      return new Response(`unsupported type: ${mediaType}`, { status: 415 });
    }
    const buf = Buffer.from(await value.arrayBuffer());
    const arr = groups.get(groupName) ?? [];
    if (arr.length >= MAX_FRAMES_PER_RECEIPT) continue;
    arr.push({ name: value.name, mediaType, base64: buf.toString("base64") });
    groups.set(groupName, arr);
  }

  if (groups.size === 0) {
    return new Response("no files received", { status: 400 });
  }
  if (groups.size > MAX_RECEIPTS) {
    return new Response(`too many receipts (max ${MAX_RECEIPTS})`, { status: 413 });
  }

  const entries = [...groups.entries()];
  const results: ScanResult[] = await Promise.all(
    entries.map(async ([sourceName, frames]): Promise<ScanResult> => {
      try {
        const receipt = await extractReceipt(
          frames.map((f) => ({ mediaType: f.mediaType, base64: f.base64 })),
        );
        return { sourceName, receipt };
      } catch (e) {
        return { sourceName, receipt: null, error: (e as Error).message };
      }
    }),
  );

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
