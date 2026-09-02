import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

// Inter for UI text (tight, neutral — reads well in dense tables and is the
// same on Mac and Windows); JetBrains Mono for PO numbers, SKUs and figures;
// Sinhala MN (the website's logo font, self-hosted from the theme) for the brand mark.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });
const brand = localFont({ src: "./fonts/sinhala-mn-regular.woff2", variable: "--font-brand", weight: "400", display: "swap" });

export const metadata: Metadata = {
  title: "Wander Doll | Product Tools",
  description: "Internal product & purchase-order tooling",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${brand.variable} h-full`}>
      <body className="h-full antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
