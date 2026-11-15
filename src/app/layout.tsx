import type { Metadata, Viewport } from "next";
import "./globals.css";

import packageJson from "../../package.json";
import AppUpdateChecker from "@/components/AppUpdateChecker";

export const metadata: Metadata = {
  title: "ワークリレー",
  description:
    "私用スマホで集めた業界ニュースや撮った写真を、社用PC・社用メールへ届ける個人用ツール",
  applicationName: "ワークリレー",
  appleWebApp: { capable: true, title: "ワークリレー", statusBarStyle: "default" },
  icons: {
    // タブ用は32px向けの簡略版（favicon）、ホーム画面・PWA用は通常版。原本は`public/brand/`（#225）
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/brand/apple-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  // ダーク時はSafariのツールバー色も暗くする（#448。ページ背景`--paper`のダーク値に合わせる）
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#087f78" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1719" },
  ],
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">
        {children}
        <AppUpdateChecker currentVersion={packageJson.version} />
      </body>
    </html>
  );
}
