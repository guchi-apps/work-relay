import test from "node:test";
import assert from "node:assert/strict";
import { pickApiCreatedDevCertificates } from "./asc-api.mjs";

const cert = (id, certificateType, displayName, name) => ({ id, attributes: { certificateType, displayName, name } });

test("displayName が Created via API の Development 証明書を選ぶ（name は接頭辞つき）", () => {
  const certs = [
    cert("1", "DEVELOPMENT", "Created via API", "Apple Development: Created via API"),
    cert("2", "IOS_DEVELOPMENT", "Created via API", "Apple Development: Created via API"),
  ];
  assert.deepEqual(pickApiCreatedDevCertificates(certs).map((c) => c.id), ["1", "2"]);
});

test("Xcode が作った証明書・Distribution 証明書は選ばない", () => {
  const certs = [
    cert("1", "DEVELOPMENT", "Taro Yamada", "Apple Development: Taro Yamada (ABC123)"),
    cert("2", "DISTRIBUTION", "Created via API", "Apple Distribution: Created via API"),
  ];
  assert.deepEqual(pickApiCreatedDevCertificates(certs), []);
});

test("displayName が無いときは接頭辞つきの name で判定する", () => {
  const certs = [cert("1", "DEVELOPMENT", undefined, "Apple Development: Created via API")];
  assert.equal(pickApiCreatedDevCertificates(certs).length, 1);
});
