"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/BrandMark";
import SidebarNav from "@/components/SidebarNav";
import { DIRECTION_LOCK_PX, EDGE_ZONE_PX, SWIPE_DIRECTION_RATIO, SWIPE_MIN_DISTANCE_PX, WIDE_EDGE_ZONE_PX } from "@/lib/nav-swipe";

const IMAGE_MAIL_PATH = "/dashboard/image-mail";
const MEMO_PATH = "/dashboard/memo";
const SETTINGS_PATH = "/settings";
// SwipeWeekNavがマウントされ、週送りスワイプと境界幅を取り合う唯一の画面（src/app/(app)/dashboard/page.tsx）。
const DASHBOARD_PATH = "/dashboard";

// アプリ全体の外殻。PC・iPad（768px以上）ではサイドバーを左に出したままにし、スマホでは
// globals.cssの`@media(max-width:767px)`でサイドバーを引き出し（ドロワー）へ切り替え、
// 上部の固定バーから開けるようにする（#80。それまでスマホはサイドバーごと非表示で、
// 「画像を送る」画面への導線が画面上に1つも無かった）。
//
// クライアントコンポーネントだが、`children`はpropsとしてそのまま受け取るだけなので、
// 配下のpage.tsxはサーバーコンポーネントのまま描画される。サイドバーがこの外殻に留まる点も
// #73と変わらず、遷移のたびに再マウントされることはない。
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // ドロワー内のリンクを選んだら閉じる。`usePathname()`の変化を`useEffect`で拾う書き方は
  // effect内のsetStateになり、react-hooks/set-state-in-effectで弾かれるためクリック側で閉じる。
  function closeIfLinkClicked(event: React.MouseEvent<HTMLElement>) {
    if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
  }

  // 開いている間は背面をスクロールさせない。閉じたときとアンマウント時に必ず戻す。
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    // 週送りスワイプ（SwipeWeekNav）と境界を取り合う/dashboardだけ従来どおりの狭い境界にし、
    // それ以外の画面は開きやすさを優先して広く取る（#123）。
    const edgeZonePx = pathname === DASHBOARD_PATH ? EDGE_ZONE_PX : WIDE_EDGE_ZONE_PX;

    let start: { x: number; y: number } | null = null;
    let fromEdge = false;
    let horizontalConfirmed = false;

    function handleTouchStart(event: TouchEvent) {
      if (event.touches.length !== 1) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
      fromEdge = touch.clientX <= edgeZonePx;
      horizontalConfirmed = false;
    }

    // 境界内から始まったタッチが横方向のドラッグだと確定した時点でだけpreventDefault()する。
    // タップ・縦スクロールと区別が付かないtouchstart時点で止めると、☰ボタンの左側やドロワー内
    // リンク、本文の縦スクロールまで巻き込んで押せなくなる（#123の計画レビューで指摘）。
    // 確定後はiOS Safariのエッジバック（「戻る」）ジェスチャーへ先に奪われないよう止め続ける。
    function handleTouchMove(event: TouchEvent) {
      if (!start || !fromEdge) return;
      if (horizontalConfirmed) {
        event.preventDefault();
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < DIRECTION_LOCK_PX && absDy < DIRECTION_LOCK_PX) return; // まだタップと区別できない
      if (absDx > absDy) {
        horizontalConfirmed = true;
        event.preventDefault();
      } else {
        fromEdge = false; // 縦スクロールと確定したので、この指の動きにはもう関与しない
      }
    }

    function handleTouchEnd(event: TouchEvent) {
      const origin = start;
      start = null;
      if (!origin || event.touches.length !== 0) return; // 全指が離れるまで確定しない
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - origin.x;
      const dy = touch.clientY - origin.y;
      const absDx = Math.abs(dx);
      if (absDx < SWIPE_MIN_DISTANCE_PX || absDx < Math.abs(dy) * SWIPE_DIRECTION_RATIO) return;
      // 左端からの右スワイプで開き、どこからでも左スワイプで閉じる。
      if (dx > 0) {
        if (fromEdge) setOpen(true);
      } else {
        setOpen(false);
      }
    }

    function handleTouchCancel() {
      start = null;
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    // 横方向確定後にpreventDefault()を呼ぶため、このリスナーだけpassive: falseにする。
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [pathname]);

  return (
    <main className={open ? "app-shell nav-open" : "app-shell"}>
      {/* スマホ専用の固定バー。PC・iPadではglobals.cssで非表示にする。 */}
      <div className="mobile-bar">
        <button type="button" className="menu-btn" aria-expanded={open} aria-label={open ? "メニューを閉じる" : "メニューを開く"} onClick={() => setOpen((current) => !current)}>
          {open ? "✕" : "☰"}
        </button>
        <BrandLogo tone="light" className="mobile-brand" />
        <span className="mobile-bar-spacer" />
        {pathname !== IMAGE_MAIL_PATH && <Link className="icon-btn" href={IMAGE_MAIL_PATH} aria-label="画像を社用メールに送る" onClick={() => setOpen(false)}>📷</Link>}
        {pathname !== MEMO_PATH && <Link className="icon-btn" href={MEMO_PATH} aria-label="メモを社用メールに送る" onClick={() => setOpen(false)}>📝</Link>}
        {pathname !== SETTINGS_PATH && <Link className="icon-btn" href={SETTINGS_PATH} aria-label="設定" onClick={() => setOpen(false)}>⚙</Link>}
      </div>
      <aside className="sidebar" onClick={closeIfLinkClicked}>
        <div className="brand">
          <BrandLogo tone="dark" />
        </div>
        <SidebarNav />
      </aside>
      <button type="button" className="nav-scrim" tabIndex={open ? 0 : -1} aria-label="メニューを閉じる" onClick={() => setOpen(false)} />
      {children}
    </main>
  );
}
