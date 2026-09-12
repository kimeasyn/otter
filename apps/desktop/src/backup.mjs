import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { chmod, copyFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// 네이티브 저장 대화상자로 승인한 새 파일에만 로컬 DB 사본을 저장한다.
export async function saveRecordBackup(store, destination) {
  if (
    typeof destination !== "string" ||
    !isAbsolute(destination) ||
    /[\0\r\n]/.test(destination)
  )
    throw new Error("백업을 저장할 파일의 절대 경로를 선택해 주세요.");
  const path = resolve(destination);
  try {
    const temporary = await mkdtemp(join(tmpdir(), "otter-record-backup-"));
    try {
      const snapshot = join(temporary, "records.sqlite");
      await backup(store.db, snapshot);
      await chmod(snapshot, 0o600);
      const createdAt = new Date().toISOString();
      const copy = new DatabaseSync(snapshot);
      try {
        // 배포할 사본은 WAL 등 옆 파일 없이 읽을 수 있어야 한다.
        copy.exec("PRAGMA journal_mode=DELETE");
        copy
          .prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
          .run(
            "otter.recordBackup",
            JSON.stringify({ format: 1, scope: "local-records", createdAt }),
          );
        const checks = copy.prepare("PRAGMA quick_check").all();
        if (checks.length !== 1 || checks[0].quick_check !== "ok")
          throw new Error("검증 실패");
      } finally {
        copy.close();
      }
      const sha256 = await digest(snapshot);
      // 기존 파일·원본 DB·링크가 존재하면 실패한다. 덮어쓰기 선택은 제공하지 않는다.
      await copyFile(snapshot, path, constants.COPYFILE_EXCL);
      const file = await open(path, "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      if ((await digest(path)) !== sha256)
        throw new Error("저장된 사본이 다릅니다");
      return {
        saved: true,
        path,
        bytes: (await stat(path)).size,
        sha256,
        createdAt,
      };
    } finally {
      // 방금 만든 전용 임시 폴더만 제거한다. 저장 대상이나 원본 데이터는 지우지 않는다.
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    throw new Error(
      error.code === "EEXIST"
        ? "같은 위치에 파일이 있어 백업을 저장하지 않았습니다. 기존 파일을 덮어쓰지 말고 다른 이름을 선택해 주세요."
        : "기록 백업의 저장·검증·정리를 완료하지 못했습니다. 원본은 바꾸지 않았습니다. 디스크와 권한을 확인하세요. 저장 위치에 사본이 남았더라도 완료된 백업으로 취급하지 마세요.",
    );
  }
}
