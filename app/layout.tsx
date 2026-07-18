import type { Metadata } from "next";
import { Noto_Sans_SC, Space_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { LOCALE_COOKIE, META_COPY, localeFromLanguage, parseLocale } from "./i18n";

const sans = Noto_Sans_SC({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

const mono = Space_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

async function requestLocale() {
  const cookieStore = await cookies();
  const saved = parseLocale(cookieStore.get(LOCALE_COOKIE)?.value);
  if (saved) return saved;
  const requestHeaders = await headers();
  return localeFromLanguage(requestHeaders.get("accept-language"));
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const copy = META_COPY[locale];
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og-v2.png`;

  return {
    title: copy.title,
    description: copy.description,
    openGraph: {
      type: "website",
      locale: copy.openGraphLocale,
      title: copy.title,
      description: copy.description,
      images: [{ url: imageUrl, width: 1536, height: 1024, alt: copy.imageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      images: [imageUrl],
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await requestLocale();
  return (
    <html lang={locale}>
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
