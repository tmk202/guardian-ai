import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata = {
  title: "Guardian — Your AI Employee Inside PayPal",
  description:
    "An AI employee plugged into your PayPal account: invoices from a sentence, dispute watching with drafted evidence, and money reports.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
