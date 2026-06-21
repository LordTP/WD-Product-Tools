import type { Metadata } from "next";
import { Poppins, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

// Poppins to match the team's Excel: Regular for body, Bold for headings.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Wander Doll · Product Tools",
  description: "Internal product & purchase-order tooling",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${poppins.variable} ${mono.variable} h-full`}>
      <body className="h-full antialiased">
        <div className="flex h-full">
          <Sidebar />
          <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-slate-100">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
