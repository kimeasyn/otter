import { join } from "node:path";
import { writeFile, rename, unlink } from "node:fs/promises";
import { startServer } from "./server.mjs";

const [directory, workerVersion, controllerId, slots, startId] =
  process.argv.slice(2);
if (!directory || !workerVersion)
  throw new Error("실행부 경로와 버전이 필요합니다.");
const app = await startServer({
  directory,
  port: 0,
  headless: true,
  workerVersion,
  controllerId,
  slots: Number(slots),
  startId,
  onShutdown: () => void requestClose(),
});
const info = join(directory, "connection.json");
const temporary = info + "." + process.pid;
await writeFile(
  temporary,
  JSON.stringify({
    pid: process.pid,
    origin: app.origin,
    token: app.token,
    workerVersion,
  }),
  { mode: 0o600, flag: "wx" },
);
await rename(temporary, info);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    const marker = {
      protocol: 1,
      workerId: app.store.metadata("workerId"),
      workerVersion,
      controllerId,
      startId,
      pid: process.pid,
      settings: app.store.settings(),
      active: 0,
      lifecycle: "stopped",
      stoppedAt: new Date().toISOString(),
    };
    await app.close();
    const stoppedTemporary = join(
      directory,
      "stopped." + process.pid + ".json",
    );
    await writeFile(stoppedTemporary, JSON.stringify(marker), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(stoppedTemporary, join(directory, "stopped.json"));
    await unlink(info).catch(() => {});
  } catch (error) {
    closing = false;
    throw error;
  }
}
function requestClose() {
  return close().catch(() => {
    console.error(
      "실행부 종료를 확인하지 못했습니다. 기존 실행과 잠금을 유지합니다.",
    );
  });
}
process.on("SIGINT", requestClose);
process.on("SIGTERM", requestClose);
