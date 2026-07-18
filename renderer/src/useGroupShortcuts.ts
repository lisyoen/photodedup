import { useEffect } from "react";
import type { GroupAction } from "./types";

const GROUP_SHORTCUTS: Record<string, GroupAction> = {
  KeyA: "apply_recommended",
  KeyS: "keep_all",
  KeyD: "delete_all",
};

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tagName = target.tagName.toLowerCase();
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset"].includes(target.type);
  }

  return (
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

export function useGroupShortcuts({
  disabled,
  modalOpen,
  onAction,
  onNavigate,
}: {
  disabled: boolean;
  modalOpen: boolean;
  onAction: (action: GroupAction) => void;
  onNavigate?: (direction: "previous" | "next") => void;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code === "ArrowUp" || event.code === "ArrowDown") {
        if (disabled || modalOpen) return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.isComposing || event.repeat) return;
        if (isEditableShortcutTarget(event.target)) return;

        event.preventDefault();
        onNavigate?.(event.code === "ArrowUp" ? "previous" : "next");
        return;
      }

      const action = GROUP_SHORTCUTS[event.code];
      if (!action) return;
      if (disabled || modalOpen) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.isComposing || event.repeat) return;
      if (isEditableShortcutTarget(event.target)) return;

      event.preventDefault();
      onAction(action);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, modalOpen, onAction, onNavigate]);
}
