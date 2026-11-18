// スマホでの横スワイプは`AppShell`のドロワー（メニューの引き出し）が使う（#80）。
// 以前は業界ニュース画面の週送り（`SwipeWeekNav`・#53）とも取り合っていたため`/dashboard`だけ
// 境界を24pxに狭めていたが、#476で週送りをやめたので全画面で同じ広い境界を使う。

// 画面左端から何px以内で始まったスワイプをドロワーの引き出しとして扱うか。24pxでは指で
// つかみにくいとの指摘（#123）を受けた広さ。
export const WIDE_EDGE_ZONE_PX = 48;

// スワイプとして扱う最小の水平移動量と、縦移動に対する比率。タップ・縦スクロール・
// `.filters`の横スクロールの巻き込みを避けるため、水平方向の移動量を優先的に見る。
export const SWIPE_MIN_DISTANCE_PX = 60;
export const SWIPE_DIRECTION_RATIO = 1.5;

// ドロワーの`touchmove`で「横方向のドラッグ」と確定させるまでの移動量（#123）。この量に
// 達するまではタップ・縦スクロールと区別できないため`preventDefault()`を呼ばない。
export const DIRECTION_LOCK_PX = 10;
