import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Receipt Scanner",
  description: "Upload photos or videos of receipts, get an Excel sheet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
