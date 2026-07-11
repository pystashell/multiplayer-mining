import type { Metadata } from "next";
import { Noto_Sans_SC, Space_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

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

const title = "同雷共苦｜双人在线扫雷";
const description = "两个人，一块雷区，一段岌岌可危的友谊。支持经典多开、插旗保护与实时合作。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title,
    description,
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title,
      description,
      images: [{ url: imageUrl, width: 1536, height: 1024, alt: "同雷共苦双人在线扫雷" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
