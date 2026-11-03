import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  return {
    title: "路绘 · 公交线路可视化制图台",
    description: "基于高德公交数据的多线路并行排线、PNG/SVG 导出与云端存档工具。",
    openGraph: {
      title: "路绘 · 公交线路可视化制图台",
      description: "多线路并行排线、卫星底图、可编辑 SVG 导出与云端存档。",
      images: [{ url: `${origin}/og.png`, width: 1734, height: 907, alt: "路绘公交线路可视化制图台" }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "路绘 · 公交线路可视化制图台",
      description: "多线路并行排线、卫星底图、可编辑 SVG 导出与云端存档。",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const amapKey = process.env.AMAP_WEB_KEY ?? "";
  const amapSecurityCode = process.env.AMAP_SECURITY_CODE ?? "";

  return (
    <html lang="zh-CN">
      <body data-amap-key={amapKey} data-amap-security-code={amapSecurityCode}>{children}</body>
    </html>
  );
}
