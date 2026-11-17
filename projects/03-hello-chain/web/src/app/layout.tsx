import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display face for headings only; body copy stays in Geist for legibility.
const displaySerif = Instrument_Serif({
  variable: "--font-display-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

/** Absolute base for Open Graph URLs: explicit site URL, else Vercel's production host, else local dev. */
function siteUrl(): URL {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) {
    try {
      return new URL(explicit);
    } catch {
      // fall through to the defaults below
    }
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return new URL(vercel ? `https://${vercel}` : "http://localhost:3000");
}

const description =
  "A guestbook that lives on a public blockchain. Sign with Face ID or your fingerprint — no wallet, no fees — and your hello stays there for good.";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: "Hello, Chain — a guestbook on the blockchain",
  description,
  applicationName: "Hello, Chain",
  openGraph: {
    type: "website",
    siteName: "Hello, Chain",
    title: "Hello, Chain",
    description,
  },
  twitter: { card: "summary_large_image", title: "Hello, Chain", description },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f1e7" },
    { media: "(prefers-color-scheme: dark)", color: "#131210" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${displaySerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
