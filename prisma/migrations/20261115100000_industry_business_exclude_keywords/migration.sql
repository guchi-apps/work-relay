-- 事業区分ごとの除外キーワードを追加する（#452）。
-- エクステリアの検索語「ポスト」が野球のポストシーズン・役職のポスト・ポストはがきなどにも一致するため、
-- 検索語を郵便ポスト系に絞り、意味の違う語を除外キーワードの初期値に入れる。
ALTER TABLE `industry_business` ADD COLUMN `excludeKeywords` JSON NULL;

UPDATE `industry_business` SET
  `excludeKeywords` = JSON_ARRAY('ポストシーズン', 'ポストを巡る', '後任ポスト', '要職ポスト', 'ポストはがき', 'ポスト葉書', 'Xのポスト', 'ポストした', 'ポストコロナ'),
  `feeds` = JSON_ARRAY(
    JSON_OBJECT('name', '宅配・住宅設備の公開情報', 'query', '(宅配ボックス OR 郵便ポスト OR 宅配ポスト OR 集合ポスト OR 玄関ポスト OR 機能門柱 OR 置き配) (新商品 OR 発表 OR 導入 OR 補助金)', 'lang', 'ja'))
WHERE `key` = 'EXTERIOR';

UPDATE `industry_business` SET `excludeKeywords` = JSON_ARRAY() WHERE `key` <> 'EXTERIOR';
