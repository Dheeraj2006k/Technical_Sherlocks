import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Playfair_Display } from "next/font/google";
import "./design.css";

const display = Playfair_Display({ variable: "--font-display", subsets: ["latin"], weight: ["600", "800"], display: "swap" });
const sans = Inter({ variable: "--font-sans", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], display: "swap", preload: false });

export const metadata: Metadata = {
  title: "Sherlock's Last Case",
  description: "Every crime leaves a query. A competitive SQL detective game.",
};

export const viewport: Viewport = {
  themeColor: "#06080c",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
