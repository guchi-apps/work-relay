"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Camera, LayoutGrid, NotebookPen } from "lucide-react";

const workspaceLinks = [
  { href: "/dashboard", icon: LayoutGrid, label: "業界ニュース" },
  { href: "/dashboard/image-mail", icon: Camera, label: "画像を送る" },
  { href: "/dashboard/memo", icon: NotebookPen, label: "メモを送る" },
];

export default function SidebarNav() {
  const pathname = usePathname();
  return (
    <>
      <p className="sidebar-label">WORKSPACE</p>
      <nav>
        {workspaceLinks.map((link, index) => (
          <Link key={index} className={pathname === link.href ? "active" : undefined} href={link.href}>
            <link.icon className="ic nav-ic" aria-hidden="true" />
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
