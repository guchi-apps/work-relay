import assert from "node:assert/strict";
import { test } from "node:test";
import { computeResizedSize } from "./image-mail-resize.ts";

test("横長は高さ（短辺）が基準になる", () => {
  assert.deepEqual(computeResizedSize(4000, 3000, 1200), { width: 1600, height: 1200 });
});

test("縦長は幅（短辺）が基準になる", () => {
  assert.deepEqual(computeResizedSize(3000, 4000, 1200), { width: 1200, height: 1600 });
});

test("正方形は両辺が基準になる", () => {
  assert.deepEqual(computeResizedSize(2000, 2000, 800), { width: 800, height: 800 });
});

test("短辺が基準以下なら拡大しない", () => {
  assert.deepEqual(computeResizedSize(1000, 700, 1200), { width: 1000, height: 700 });
});

test("端数は四捨五入し、極端な縦横比でも1px未満にならない", () => {
  assert.deepEqual(computeResizedSize(4032, 3024, 1600), { width: 2133, height: 1600 });
  assert.deepEqual(computeResizedSize(10000, 1, 1200), { width: 10000, height: 1 });
});
