-- AlterTable
ALTER TABLE `article_analyses` ADD COLUMN `inputTokens` INTEGER NULL,
    ADD COLUMN `outputTokens` INTEGER NULL,
    ADD COLUMN `cacheReadTokens` INTEGER NULL,
    ADD COLUMN `cacheWriteTokens` INTEGER NULL;

-- AlterTable
ALTER TABLE `collection_search_jobs` ADD COLUMN `inputTokens` INTEGER NULL,
    ADD COLUMN `outputTokens` INTEGER NULL,
    ADD COLUMN `cacheReadTokens` INTEGER NULL,
    ADD COLUMN `cacheWriteTokens` INTEGER NULL;
