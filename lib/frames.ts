// Client-side: extract frames from a video file in the browser.
// 1 frame per second, deduped via average-hash Hamming distance.

const FPS = 1;
const MAX_FRAMES = 30;
const MAX_LONG_EDGE = 1280;
const JPEG_QUALITY = 0.72;
const HASH_SIZE = 8;
const DUPE_THRESHOLD = 6; // Hamming distance below this = duplicate

export type ExtractedFrame = { blob: Blob; tSec: number };

export async function extractFramesFromVideo(file: File): Promise<ExtractedFrame[]> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("failed to load video"));
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("video duration unknown");
    }

    const { width: outW, height: outH } = fitWithin(
      video.videoWidth,
      video.videoHeight,
      MAX_LONG_EDGE,
    );
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");

    const hashCanvas = document.createElement("canvas");
    hashCanvas.width = HASH_SIZE;
    hashCanvas.height = HASH_SIZE;
    const hashCtx = hashCanvas.getContext("2d", { willReadFrequently: true });
    if (!hashCtx) throw new Error("hash canvas 2d context unavailable");

    const out: ExtractedFrame[] = [];
    const hashes: bigint[] = [];
    const total = Math.min(MAX_FRAMES, Math.max(1, Math.floor(duration * FPS)));

    for (let i = 0; i < total; i++) {
      const t = Math.min(duration - 0.01, i / FPS);
      await seek(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      hashCtx.drawImage(canvas, 0, 0, HASH_SIZE, HASH_SIZE);
      const hash = averageHash(hashCtx.getImageData(0, 0, HASH_SIZE, HASH_SIZE));
      const dupe = hashes.some((h) => hamming(h, hash) < DUPE_THRESHOLD);
      if (dupe) continue;
      hashes.push(hash);
      const blob = await canvasToBlob(canvas);
      out.push({ blob, tSec: t });
      if (out.length >= MAX_FRAMES) break;
    }

    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("seek failed"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = t;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

function fitWithin(w: number, h: number, maxLongEdge: number): { width: number; height: number } {
  const longEdge = Math.max(w, h);
  if (longEdge <= maxLongEdge) return { width: w, height: h };
  const scale = maxLongEdge / longEdge;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function averageHash(img: ImageData): bigint {
  const px = img.data;
  const grays = new Array<number>(HASH_SIZE * HASH_SIZE);
  let sum = 0;
  for (let i = 0; i < grays.length; i++) {
    const r = px[i * 4];
    const g = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    const y = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    grays[i] = y;
    sum += y;
  }
  const avg = sum / grays.length;
  let hash = 0n;
  for (let i = 0; i < grays.length; i++) {
    if (grays[i] >= avg) hash |= 1n << BigInt(i);
  }
  return hash;
}

function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
