import { useEffect, type ReactNode } from "react";
import { ModerationTitleBar } from "./ModerationTitleBar";
import { ModerationUpdateOverlay } from "./ModerationUpdateOverlay";

export function AppShell({ children }: { children: ReactNode }) {
  const electron = typeof window !== "undefined" && !!window.slonmod?.minimizeWindow;

  useEffect(() => {
    if (electron) document.documentElement.classList.add("electron");
    else document.documentElement.classList.remove("electron");
    return () => document.documentElement.classList.remove("electron");
  }, [electron]);

  if (!electron) return <>{children}</>;

  return (
    <div className="electron-root">
      <ModerationUpdateOverlay />
      <ModerationTitleBar />
      <div className="electron-root__body">{children}</div>
    </div>
  );
}
