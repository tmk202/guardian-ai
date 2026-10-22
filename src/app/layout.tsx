import type { ReactNode } from "react";

export const metadata = {
  title: "Guardian — Your AI Employee Inside PayPal",
  description:
    "An AI employee plugged into your PayPal account: invoices from a sentence, dispute watching with drafted evidence, and money reports.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
