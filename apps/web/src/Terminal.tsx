import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useAuth } from "./api";
import "@xterm/xterm/css/xterm.css";

export type TerminalTarget = {
  projectId: string;
  worktreeId?: string;
  workUnitId?: string;
  label: string;
};
export function Terminal({
  target,
  onClose,
}: {
  target: TerminalTarget;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting");
  useEffect(() => {
    if (!container.current) return;
    const terminal = new Xterm({
      fontSize: 13,
      fontFamily: "ui-monospace, monospace",
      cursorBlink: true,
      screenReaderMode: true,
      theme: { background: "#101719", foreground: "#dce6e5" },
      scrollback: 3000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    fit.fit();
    const query = new URLSearchParams({ project_id: target.projectId });
    if (target.worktreeId) query.set("worktree_id", target.worktreeId);
    if (target.workUnitId) query.set("work_unit_id", target.workUnitId);
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminals/ws?${query}`,
      ["otter", `otter.auth.${useAuth.getState().token}`],
    );
    socket.binaryType = "arraybuffer";
    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
    };
    socket.onopen = () => {
      setStatus("Running");
      resize();
      terminal.focus();
    };
    socket.onmessage = (e) =>
      terminal.write(
        typeof e.data === "string" ? e.data : new Uint8Array(e.data),
      );
    socket.onerror = () => {
      setStatus("Connection failed");
      terminal.writeln(
        "\r\nTerminal connection failed. Check daemon authentication and the selected directory.",
      );
    };
    socket.onclose = () => {
      setStatus("Stopped");
      terminal.writeln("\r\n[Terminal stopped]");
    };
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "input", data }));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    return () => {
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [target]);
  return (
    <section className="terminal-panel">
      <div className="section-title">
        <h2>Terminal · {target.label}</h2>
        <span className="muted">{status} · Runs as your local user</span>
        <button onClick={onClose}>Close terminal</button>
      </div>
      <div
        ref={container}
        className="terminal-container"
        role="region"
        aria-label="Interactive terminal"
      />
    </section>
  );
}
