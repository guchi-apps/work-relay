-- AI関連の収集範囲を、主要な新機能・大型アップデートと具体的な活用事例に絞る（#424）。
-- 調整済みの判定基準（collection_search_policy）は上書きしない。収集プロンプト側の絞り込み規則が優先する。
UPDATE `industry_business` SET
  `scope` = 'Gemini、Microsoft Copilot（Microsoft 365 Copilot・GitHub Copilot等）の主要な新機能・大型アップデートと、業務での具体的な活用事例',
  `defaultPolicy` = 'Gemini・Copilotについて、主要な新機能・大型アップデートと、業務での具体的な活用事例に絞って一次情報を優先する。企業の参入・提携・人事・資金調達、細かい料金改定、小規模な更新、話題の背景に出るだけの記事は採用しない。該当が無ければ採用しなくてよい。',
  `feeds` = JSON_ARRAY(
    JSON_OBJECT('name', 'Gemini・Copilotの公開情報', 'query', '(Gemini OR Copilot OR "Microsoft 365 Copilot" OR "GitHub Copilot") (新機能 OR アップデート OR 活用事例)', 'lang', 'ja'),
    JSON_OBJECT('name', 'Gemini・Copilotの海外情報', 'query', '(Gemini OR "Microsoft Copilot" OR "GitHub Copilot") (new feature OR launches OR rollout OR use case)', 'lang', 'en'))
WHERE `key` = 'AI';
