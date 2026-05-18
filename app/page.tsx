"use client";

import { useCallback, useRef, useState } from "react";
import { extractFramesFromVideo } from "@/lib/frames";

type PendingFile = {
  id: string;
  file: File;
  kind: "image" | "video";
  status: "queued" | "preparing" | "ready" | "error";
  framesCount?: number;
  error?: string;
};

export default function HomePage() {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = useCallback((picked: FileList | null) => {
    if (!picked) return;
    const next: PendingFile[] = [];
    for (const f of Array.from(picked)) {
      const kind: "image" | "video" | null = f.type.startsWith("image/")
        ? "image"
        : f.type.startsWith("video/")
          ? "video"
          : null;
      if (!kind) continue;
      next.push({
        id: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`,
        file: f,
        kind,
        status: "queued",
      });
    }
    setFiles((prev) => [...prev, ...next]);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      onPick(e.dataTransfer.files);
    },
    [onPick],
  );

  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));
  const clearAll = () => setFiles([]);

  const generate = async () => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      const updated = [...files];

      for (let i = 0; i < updated.length; i++) {
        const pf = updated[i];
        const key = `${i}_${pf.file.name}`;
        if (pf.kind === "image") {
          form.append(key, pf.file, pf.file.name);
          updated[i] = { ...pf, status: "ready", framesCount: 1 };
        } else {
          updated[i] = { ...pf, status: "preparing" };
          setFiles([...updated]);
          try {
            const frames = await extractFramesFromVideo(pf.file);
            if (frames.length === 0) {
              updated[i] = { ...pf, status: "error", error: "no frames extracted" };
              continue;
            }
            frames.forEach((fr, idx) => {
              form.append(key, fr.blob, `${pf.file.name}_frame${idx}.jpg`);
            });
            updated[i] = { ...pf, status: "ready", framesCount: frames.length };
          } catch (e) {
            updated[i] = { ...pf, status: "error", error: (e as Error).message };
          }
        }
        setFiles([...updated]);
      }

      const ready = updated.filter((u) => u.status === "ready");
      if (ready.length === 0) {
        setMessage("nothing to send — all files failed to prepare");
        return;
      }

      const resp = await fetch("/api/scan", { method: "POST", body: form });
      if (!resp.ok) {
        const text = await resp.text();
        setMessage(`server error ${resp.status}: ${text}`);
        return;
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = resp.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename="([^"]+)"/);
      a.download = m ? m[1] : "receipts.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage("done — file downloaded");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Receipt Scanner</h1>
        <p className="mt-2 text-zinc-600">
          Drop photos or videos of receipts. Get back an Excel file with the line items.
          Files are processed in memory and never stored.
        </p>
      </header>

      <label
        htmlFor="file-input"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 bg-white p-12 text-center transition hover:border-zinc-400 hover:bg-zinc-50"
      >
        <span className="text-lg font-medium">Drop receipts here</span>
        <span className="mt-1 text-sm text-zinc-500">
          or click to choose — images and videos accepted
        </span>
        <input
          ref={inputRef}
          id="file-input"
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => onPick(e.target.files)}
        />
      </label>

      {files.length > 0 && (
        <section className="mt-6 rounded-xl border border-zinc-200 bg-white">
          <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <span className="text-sm font-medium">{files.length} file(s)</span>
            <button
              onClick={clearAll}
              disabled={busy}
              className="text-sm text-zinc-500 hover:text-zinc-800 disabled:opacity-50"
            >
              clear
            </button>
          </header>
          <ul className="divide-y divide-zinc-100">
            {files.map((f) => (
              <li key={f.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{f.file.name}</div>
                  <div className="text-xs text-zinc-500">
                    {f.kind} · {(f.file.size / 1024 / 1024).toFixed(2)} MB
                    {f.framesCount ? ` · ${f.framesCount} frame(s)` : ""}
                    {f.error ? ` · ${f.error}` : ""}
                  </div>
                </div>
                <StatusBadge status={f.status} />
                <button
                  onClick={() => removeFile(f.id)}
                  disabled={busy}
                  className="ml-3 text-zinc-400 hover:text-zinc-800 disabled:opacity-50"
                  aria-label="remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={generate}
          disabled={busy || files.length === 0}
          className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Processing…" : "Generate Excel"}
        </button>
        {message && <span className="text-sm text-zinc-600">{message}</span>}
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: PendingFile["status"] }) {
  const label = {
    queued: "queued",
    preparing: "preparing…",
    ready: "ready",
    error: "error",
  }[status];
  const cls = {
    queued: "bg-zinc-100 text-zinc-700",
    preparing: "bg-amber-100 text-amber-800",
    ready: "bg-emerald-100 text-emerald-800",
    error: "bg-red-100 text-red-800",
  }[status];
  return (
    <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}
