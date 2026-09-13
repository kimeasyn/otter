import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";

test("아바타 생성·파생·원격 가져오기·프로젝트별 편집과 기존 값 보존", () => {
  const store = new Store();
  const company = new Company(store);
  try {
    const input = { name: "김코딩", role: "개발", instructions: "검사" };
    for (const avatar of [
      "default",
      "glasses",
      "bob",
      "curly",
      "cap",
      "headset",
    ]) {
      const employee = company.createEmployee({ ...input, avatar });
      assert.equal(employee.appearance.avatar, avatar);
    }
    const employee = company.createEmployee({ ...input, avatar: "bob" });
    const derived = company.createEmployee({
      ...input,
      sourceId: employee.id,
      sourceRevision: employee.revision,
    });
    assert.equal(derived.appearance.avatar, "bob");
    const imported = company.importSettings(
      {
        employee: {
          ...employee,
          revision: 2,
          appearance: { avatar: "cap", color: "#123456" },
        },
      },
      true,
    ).employees;
    assert.deepEqual(imported.appearance, { avatar: "cap", color: "#123456" });
    const org = company.createCompany({ name: "아바타 검사", mode: "group" });
    const a = store.insert("projects", {
      companyId: org.id,
      name: "A",
      root: "/fixture-avatar-a",
    });
    const b = store.insert("projects", {
      companyId: org.id,
      name: "B",
      root: "/fixture-avatar-b",
    });
    const aa = company.assign(a.id, employee.id);
    const ab = company.assign(b.id, employee.id);
    const edited = company.editAssignment(aa.id, {
      ...input,
      revision: aa.revision,
      avatar: "headset",
    });
    assert.equal(edited.appearance.avatar, "headset");
    assert.equal(store.get("assignments", ab.id).appearance.avatar, "cap");
    assert.equal(store.get("employees", employee.id).appearance.avatar, "cap");
    assert.equal(
      company.editAssignment(aa.id, { ...input, revision: edited.revision })
        .appearance.avatar,
      "headset",
    );
    const next = company.editEmployee(employee.id, {
      ...input,
      revision: imported.revision,
      avatar: "glasses",
    });
    assert.deepEqual(next.appearance, { avatar: "glasses", color: "#123456" });
    assert.equal(
      company.editEmployee(employee.id, { ...input, revision: next.revision })
        .appearance.avatar,
      "glasses",
    );
    assert.throws(
      () => company.createEmployee({ ...input, avatar: "unknown" }),
      /아바타/,
    );
  } finally {
    store.close();
  }
});
