-- 事業区分（宅配／ロッカー）をenumからDBのマスタへ移し、「エクステリア／ロッカー／AI関連」の3区分に整理する。
-- 旧DELIVERYはEXTERIORへ読み替える。既存の記事・AI解析・調整済みの判定基準は件数ごと引き継ぐ。

CREATE TABLE `industry_business` (
    `key` VARCHAR(32) NOT NULL,
    `label` VARCHAR(100) NOT NULL,
    `shortLabel` VARCHAR(50) NOT NULL,
    `hint` VARCHAR(255) NOT NULL DEFAULT '',
    `scope` TEXT NOT NULL,
    `defaultPolicy` TEXT NOT NULL,
    `color` VARCHAR(16) NOT NULL DEFAULT 'teal',
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `feeds` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `industry_business` (`key`, `label`, `shortLabel`, `hint`, `scope`, `defaultPolicy`, `color`, `sortOrder`, `feeds`) VALUES
('EXTERIOR', 'エクステリア事業', 'エクステリア', '戸建て · 宅配ボックス · ポスト · 機能門柱 · 外構',
 '宅配ボックス、郵便ポスト、機能門柱、置き配、防犯（なりすまし受け取り・盗難）、施工性、配送ロボット／ドローン配送',
 '宅配ボックス・ポスト・機能門柱について、商品企画、市場、導入、制度、安全性に役立つ一次情報を優先する。話題の背景に出るだけの記事、人事・芸能・スポーツなど事業と直接関係しない記事は採用しない。',
 'teal', 1,
 JSON_ARRAY(JSON_OBJECT('name', '宅配・住宅設備の公開情報', 'query', '(宅配ボックス OR ポスト OR 機能門柱 OR 置き配) (新商品 OR 発表 OR 導入 OR 補助金)', 'lang', 'ja'))),
('LOCKER', 'ロッカー事業', 'ロッカー', 'マルチロッカー · セルフ発送 · 競合・類似サービス',
 'マルチロッカー、セルフ発送機、PUDO・SMARI・Amazon Hub等の受取／発送／返品、ロッカーの運用・設置・事業性',
 'マルチロッカーについて、商品企画、市場、導入、制度、安全性に役立つ一次情報を優先する。話題の背景に出るだけの記事、人事・芸能・スポーツなど事業と直接関係しない記事は採用しない。',
 'orange', 2,
 JSON_ARRAY(
   JSON_OBJECT('name', 'ロッカー・発送サービスの公開情報', 'query', '(PUDO OR SMARI OR Amazon Hub OR マルチエキューブ OR SPACER OR セルフ発送) (導入 OR 発表 OR 物流 OR 返品)', 'lang', 'ja'),
   JSON_OBJECT('name', '海外ロッカー事例', 'query', '(parcel locker OR locker drop-off OR self-service shipping kiosk)', 'lang', 'en'))),
('AI', 'AI関連', 'AI', 'Gemini · Copilot · 生成AI · 業務活用',
 'Gemini、Microsoft Copilot（Microsoft 365 Copilot・GitHub Copilot等）の新機能、料金・プラン、法人向けの導入・活用事例、安全性・ガバナンス',
 'Gemini・Copilotについて、新機能、料金・プラン、導入・活用事例、セキュリティやガバナンスに役立つ一次情報を優先する。話題の背景に出るだけの記事、人事・芸能・スポーツなどAIの利用と直接関係しない記事は採用しない。',
 'violet', 3,
 JSON_ARRAY(
   JSON_OBJECT('name', 'Gemini・Copilotの公開情報', 'query', '(Gemini OR Copilot OR "Microsoft 365 Copilot" OR "GitHub Copilot") (新機能 OR 発表 OR 料金 OR 導入)', 'lang', 'ja'),
   JSON_OBJECT('name', 'Gemini・Copilotの海外情報', 'query', '(Gemini OR "Microsoft Copilot" OR "GitHub Copilot") (announces OR launches OR pricing OR enterprise)', 'lang', 'en')));

-- enum → VARCHAR（文字列はそのまま保たれる）。旧DELIVERYはEXTERIORへ。
ALTER TABLE `industry_information` MODIFY COLUMN `business` VARCHAR(32) NOT NULL;
ALTER TABLE `collection_search_policy` MODIFY COLUMN `business` VARCHAR(32) NOT NULL;
ALTER TABLE `article_analyses` MODIFY COLUMN `relevance` VARCHAR(32) NOT NULL;

UPDATE `industry_information` SET `business` = 'EXTERIOR' WHERE `business` = 'DELIVERY';
UPDATE `collection_search_policy` SET `business` = 'EXTERIOR' WHERE `business` = 'DELIVERY';
UPDATE `article_analyses` SET `relevance` = 'EXTERIOR' WHERE `relevance` = 'DELIVERY';

-- タグの「宅配事業」は区分名に合わせて更新する（JSON配列の該当要素だけ置換）。
UPDATE `industry_information`
SET `tags` = JSON_REPLACE(`tags`, JSON_UNQUOTE(JSON_SEARCH(`tags`, 'one', '宅配事業')), 'エクステリア事業')
WHERE `tags` IS NOT NULL AND JSON_SEARCH(`tags`, 'one', '宅配事業') IS NOT NULL;

ALTER TABLE `industry_information` ADD CONSTRAINT `industry_information_business_fkey` FOREIGN KEY (`business`) REFERENCES `industry_business`(`key`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `collection_search_policy` ADD CONSTRAINT `collection_search_policy_business_fkey` FOREIGN KEY (`business`) REFERENCES `industry_business`(`key`) ON DELETE RESTRICT ON UPDATE CASCADE;
