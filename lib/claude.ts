import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ReceiptSchema, type Receipt } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACT_MODEL = "claude-sonnet-4-6";
const SEGMENT_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You extract line items from receipt photos.

Return ONLY a JSON object matching this exact schema (no prose, no markdown, no code fences):
{
  "merchant": string | null,
  "date": string | null,
  "currency": string | null,
  "items": [
    { "name": string, "qty": number, "unit_price": number, "total": number }
  ],
  "subtotal": number | null,
  "tax": number | null,
  "tax_label": string | null,
  "tax_rate": number | null,
  "total": number | null
}

Rules:
- If a value is unreadable, omit that item rather than guess. For top-level fields, use null when not present on the receipt.
- When multiple frames of the same receipt are provided, treat them as one receipt and do not duplicate items.
- "qty" defaults to 1 if not shown. Item "total" = qty * unit_price when not explicitly printed.
- "subtotal" is the items total before tax. "tax" is the tax/VAT amount as printed. "tax_label" is the printed label (e.g. "VAT", "GST", "Sales Tax", "PH VAT 12%"). "tax_rate" is the decimal rate if printed (e.g. 0.12 for 12%).
- "total" is the grand total the customer paid, including tax.
- Numbers must be plain numbers, no currency symbols, no thousands separators. Use a period as the decimal separator.
- Output must be valid JSON parseable by JSON.parse.`;

type ImageInput = { mediaType: string; base64: string };

export async function extractReceipt(images: ImageInput[]): Promise<Receipt> {
  if (images.length === 0) throw new Error("no images provided");

  const userContent: Anthropic.ContentBlockParam[] = images.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType as Anthropic.Base64ImageSource["media_type"],
      data: img.base64,
    },
  }));
  userContent.push({
    type: "text",
    text: "Extract the receipt items as JSON per the schema. Output JSON only.",
  });

  const raw = await callOnce(userContent);
  const parsed = tryParse(raw);
  if (parsed.success) return parsed.data;

  const retryContent: Anthropic.ContentBlockParam[] = [
    ...userContent,
    {
      type: "text",
      text: `Your previous response was not valid JSON or did not match the schema. Error: ${parsed.error}. Output ONLY the JSON object now.`,
    },
  ];
  const raw2 = await callOnce(retryContent);
  const parsed2 = tryParse(raw2);
  if (parsed2.success) return parsed2.data;

  throw new Error(`Claude returned invalid JSON twice: ${parsed2.error}`);
}

async function callOnce(content: Anthropic.ContentBlockParam[]): Promise<string> {
  const resp = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content }],
  });
  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block in Claude response");
  return block.text.trim();
}

function tryParse(
  raw: string,
): { success: true; data: Receipt } | { success: false; error: string } {
  const cleaned = stripCodeFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (e) {
    return { success: false, error: `JSON.parse failed: ${(e as Error).message}` };
  }
  const result = ReceiptSchema.safeParse(json);
  if (!result.success) {
    return { success: false, error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { success: true, data: result.data };
}

function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

const SegmentationSchema = z.object({
  groups: z
    .array(
      z.object({
        frame_indices: z.array(z.number().int().nonnegative()).min(1),
        label: z.string().optional().nullable(),
      }),
    )
    .min(1),
});

const SEGMENT_SYSTEM = `You analyze video frames that may show one or more paper receipts.

You will receive N frames in order. Your job: group the frames by which physical receipt they show.

Return ONLY this JSON (no prose, no markdown, no code fences):
{
  "groups": [
    { "frame_indices": [int, ...], "label": "Receipt 1" }
  ]
}

Rules:
- Each group represents ONE physical receipt. Different angles, partial views, or zooms of the same paper belong to the same group.
- Skip frames that are blurry-only, hands-only, blank, transitions, or do not show a readable receipt.
- frame_indices use the 0-based order in which frames were provided.
- A frame index must appear in at most one group.
- If you are unsure whether two visually-different views are the same receipt, prefer the SAME group (merge), not separate groups. We would rather under-split than over-split.
- If you genuinely see only one receipt across the whole video, return exactly one group containing all readable frames.`;

export type FrameGroup = { frame_indices: number[]; label: string };

export async function segmentVideoFrames(images: ImageInput[]): Promise<FrameGroup[]> {
  if (images.length === 0) return [];
  if (images.length === 1) return [{ frame_indices: [0], label: "Receipt 1" }];

  const content: Anthropic.ContentBlockParam[] = images.flatMap((img, idx) => [
    { type: "text" as const, text: `frame ${idx}:` },
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType as Anthropic.Base64ImageSource["media_type"],
        data: img.base64,
      },
    },
  ]);
  content.push({
    type: "text",
    text: `Group these ${images.length} frames by physical receipt. JSON only.`,
  });

  const resp = await client.messages.create({
    model: SEGMENT_MODEL,
    max_tokens: 1024,
    system: SEGMENT_SYSTEM,
    messages: [{ role: "user", content }],
  });
  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    return [{ frame_indices: images.map((_, i) => i), label: "Receipt 1" }];
  }

  const cleaned = stripCodeFence(block.text.trim());
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return [{ frame_indices: images.map((_, i) => i), label: "Receipt 1" }];
  }
  const parsed = SegmentationSchema.safeParse(json);
  if (!parsed.success) {
    return [{ frame_indices: images.map((_, i) => i), label: "Receipt 1" }];
  }

  const seen = new Set<number>();
  const groups: FrameGroup[] = [];
  parsed.data.groups.forEach((g, i) => {
    const idxs = g.frame_indices.filter(
      (n) => n >= 0 && n < images.length && !seen.has(n),
    );
    idxs.forEach((n) => seen.add(n));
    if (idxs.length === 0) return;
    groups.push({ frame_indices: idxs, label: g.label || `Receipt ${i + 1}` });
  });

  if (groups.length === 0) {
    return [{ frame_indices: images.map((_, i) => i), label: "Receipt 1" }];
  }
  return groups;
}
