import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateZipSize, formatPartSuffix, planGroups } from "./image-mail-split.ts";

describe("planGroups", () => {
  it("上限に収まるなら1グループにする", () => {
    assert.deepEqual(planGroups([100, 200, 300], 10_000), [[0, 1, 2]]);
  });

  it("上限を超える手前で区切り、順序を保つ", () => {
    const limit = estimateZipSize([500, 500]);
    assert.deepEqual(planGroups([500, 500, 500, 500, 500], limit), [[0, 1], [2, 3], [4]]);
  });

  it("1枚だけで上限を超える画像は単独のグループになる", () => {
    assert.deepEqual(planGroups([100, 5_000, 100], 1_000), [[0], [1], [2]]);
  });

  it("画像が無ければ空", () => {
    assert.deepEqual(planGroups([], 1_000), []);
  });
});

describe("formatPartSuffix", () => {
  it("1通だけなら付けない", () => {
    assert.equal(formatPartSuffix(1, 1), "");
  });
  it("複数通なら連番を付ける", () => {
    assert.equal(formatPartSuffix(2, 3), " (2/3)");
  });
});
