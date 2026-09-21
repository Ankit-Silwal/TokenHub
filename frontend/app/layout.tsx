import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "TokenHub — More possibility, together.",
  description:
    "Lend a little AI. Build something great. Private, permission-based Codex conversations.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
