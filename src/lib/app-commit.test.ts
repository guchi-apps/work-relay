import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAppCommitSha } from "./app-commit.ts";

describe("readAppCommitSha", () => {
  it("APP_COMMIT_SHA が入っていればその値を返す", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(readAppCommitSha({ APP_COMMIT_SHA: sha }), sha);
  });
  it("前後の空白は落とす（.env の書き方で照合が外れないようにする）", () => {
    assert.equal(readAppCommitSha({ APP_COMMIT_SHA: "  abc123\n" }), "abc123");
  });
  it("未設定・空文字・空白だけなら null", () => {
    assert.equal(readAppCommitSha({}), null);
    assert.equal(readAppCommitSha({ APP_COMMIT_SHA: "" }), null);
    assert.equal(readAppCommitSha({ APP_COMMIT_SHA: "   " }), null);
  });
});
