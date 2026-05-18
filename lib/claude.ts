import Anthropic from "@anthropic-ai/sdk";
import { ReceiptSchema, type Receipt } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You extract line items from receipt photos.

Return ONLY a JSON object matching this exact schema (no prose, no markdown, no code fences):
{
  "merchant": string | null,
  "date": string | null,
  "currency": string | null,
  "items": [
    { "name": string, "qty": number, "unit_price": number, "total": number }
  ]
}

Rules:
- If a value is unreadable, omit that item rather than guess.
- When multiple frames of the same receipt are provided, treat them as one receipt and do not duplicate items.
- "qty" defaults to 1 if not shown. "total" = qty * unit_price when total is not explicitly printed.
- Numbers must be plain numbers, no currency symbols, no thousands separators.
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
    model: MODEL,
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
