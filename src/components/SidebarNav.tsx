"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const workspaceLinks = [
  { href: "/dashboard", label: "▦　業界ニュース" },
  { href: "/dashboard/inbox", label: "📥　新着記事" },
  { href: "/dashboard/image-mail", label: "📷　画像を送る" },
];

export default function SidebarNav() {
  const pathname = usePathname();
  return (
    <>
      <p className="sidebar-label">WORKSPACE</p>
      <nav>
        {workspaceLinks.map((link, index) => (
          <Link key={index} className={pathname === link.href ? "active" : undefined} href={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
