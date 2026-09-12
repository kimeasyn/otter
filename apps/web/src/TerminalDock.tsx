import { lazy, Suspense, useState } from "react";
import type { TerminalTarget } from "./Terminal";
const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);
export type TerminalTab = { id: string; target: TerminalTarget };
export function terminalKey(target: TerminalTarget) {
  return JSON.stringify([
    target.projectId,
    target.worktreeId ?? "",
    target.workUnitId ?? "",
  ]);
}
export function TerminalDock({
  tabs,
  active,
  onActive,
  onClose,
}: {
  tabs: TerminalTab[];
  active: string;
  onActive: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const [height, setHeight] = useState(260);
  if (!tabs.length) return null;
  return (
    <div
      className={`terminal-dock ${active ? "expanded" : "collapsed"}`}
      style={{ "--terminal-height": `${height}px` } as React.CSSProperties}
    >
      <div className="dock-toolbar">
        <strong>TERMINAL</strong>
        <div role="tablist" aria-label="Terminal sessions">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active === tab.id}
              onClick={() => onActive(tab.id)}
            >
              {tab.target.label}
            </button>
          ))}
        </div>
        {active && (
          <label className="dock-size">
            Height
            <input
              aria-label="Terminal height"
              type="range"
              min="140"
              max="480"
              step="20"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </label>
        )}
        <button onClick={() => onActive(active ? "" : tabs[0].id)}>
          {active ? "Hide terminal" : "Show terminal"}
        </button>
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} hidden={active !== tab.id}>
          <Suspense fallback={<p>Loading terminal…</p>}>
            <Terminal
              target={tab.target}
              onClose={() => {
                if (
                  window.confirm(
                    `Close terminal “${tab.target.label}”? Its shell and running commands will stop. Use Hide terminal to keep it running.`,
                  )
                )
                  onClose(tab.id);
              }}
            />
          </Suspense>
        </div>
      ))}
    </div>
  );
}
