import test from "node:test";
import assert from "node:assert/strict";
import { computeThumbnailSize } from "./image-mail-resize.ts";
import { shouldSkipThumbnails } from "./image-mail-thumbnail.ts";

test("長辺300pxに縮小する", () => {
  assert.deepEqual(computeThumbnailSize(4000, 3000), { width: 300, height: 225 });
  assert.deepEqual(computeThumbnailSize(3000, 4000), { width: 225, height: 300 });
});

test("小さい画像は拡大しない", () => {
  assert.deepEqual(computeThumbnailSize(200, 100), { width: 200, height: 100 });
});

test("低速回線・データ節約では省略する", () => {
  assert.equal(shouldSkipThumbnails({ effectiveType: "2g" }), true);
  assert.equal(shouldSkipThumbnails({ effectiveType: "4g", saveData: true }), true);
  assert.equal(shouldSkipThumbnails({ effectiveType: "4g" }), false);
  assert.equal(shouldSkipThumbnails(null), false);
});
