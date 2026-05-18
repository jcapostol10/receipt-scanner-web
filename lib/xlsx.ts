import ExcelJS from "exceljs";
import type { ScanResult } from "./types";

export async function buildWorkbook(results: ScanResult[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "receipt-scanner-web";
  wb.created = new Date();

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Source", key: "source", width: 28 },
    { header: "Merchant", key: "merchant", width: 22 },
    { header: "Date", key: "date", width: 14 },
    { header: "Item", key: "name", width: 36 },
    { header: "Qty", key: "qty", width: 8 },
    { header: "Unit Price", key: "unit_price", width: 12 },
    { header: "Total", key: "total", width: 12 },
  ];
  styleHeader(summary);

  const used = new Set<string>();
  for (const r of results) {
    const sheetName = uniqueSheetName(r.sourceName, used);
    const ws = wb.addWorksheet(sheetName);

    if (r.error || !r.receipt) {
      ws.addRow(["Source", r.sourceName]);
      ws.addRow(["Error", r.error ?? "no data"]);
      continue;
    }

    const { merchant, date, currency, items } = r.receipt;
    ws.addRow(["Source", r.sourceName]);
    ws.addRow(["Merchant", merchant ?? ""]);
    ws.addRow(["Date", date ?? ""]);
    ws.addRow(["Currency", currency ?? ""]);
    ws.addRow([]);

    const headerRow = ws.addRow(["Item", "Qty", "Unit Price", "Total"]);
    headerRow.font = { bold: true };
    ws.columns = [
      { width: 36 },
      { width: 8 },
      { width: 12 },
      { width: 12 },
    ];

    for (const item of items) {
      ws.addRow([item.name, item.qty, item.unit_price, item.total]);
      summary.addRow({
        source: r.sourceName,
        merchant: merchant ?? "",
        date: date ?? "",
        name: item.name,
        qty: item.qty,
        unit_price: item.unit_price,
        total: item.total,
      });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function styleHeader(ws: ExcelJS.Worksheet) {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function uniqueSheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[\\/?*[\]:]/g, " ").slice(0, 28).trim() || "Receipt";
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${i++})`;
    name = base.slice(0, 28 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}
