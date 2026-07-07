import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Store } from "@tauri-apps/plugin-store";

export const STORE_FILE = "settings.json";
export const WORKSPACE_KEY = "workspacePath";

interface Props {
  onWorkspaceSet: (path: string) => void;
}

export default function FirstRun({ onWorkspaceSet }: Props) {
  const [picking, setPicking] = useState(false);

  async function pickWorkspace() {
    setPicking(true);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose your ContentViewPro workspace folder",
      });
      if (selected && typeof selected === "string") {
        const store = await Store.load(STORE_FILE);
        await store.set(WORKSPACE_KEY, selected);
        await store.save();
        onWorkspaceSet(selected);
      }
    } finally {
      setPicking(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--color-bg)" }}
    >
      <div
        className="w-full max-w-md p-8 rounded-lg border"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border)",
        }}
      >
        <h1
          className="text-xl font-bold mb-2"
          style={{ color: "var(--color-text)" }}
        >
          Welcome to ContentViewPro
        </h1>
        <p
          className="text-sm mb-6"
          style={{ color: "var(--color-text-muted)" }}
        >
          Choose a folder for your workspace. Your drafts, reviews, and state
          will be stored there.
        </p>
        <button
          onClick={pickWorkspace}
          disabled={picking}
          className="w-full py-3 rounded-lg font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "var(--color-primary)", color: "#fff" }}
        >
          {picking ? "Choosing..." : "Choose Workspace Folder"}
        </button>
      </div>
    </div>
  );
}
