import { z } from "zod";

export const ReceiptItemSchema = z.object({
  name: z.string().min(1),
  qty: z.number().nonnegative(),
  unit_price: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

export const ReceiptSchema = z.object({
  merchant: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  items: z.array(ReceiptItemSchema),
});

export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;

export type ScanResult = {
  sourceName: string;
  receipt: Receipt | null;
  error?: string;
};
