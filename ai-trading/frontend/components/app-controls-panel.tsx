"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { hubApps } from "@/lib/apps";
import type { AppId, AppState } from "@/lib/controls";
import { useAppControls } from "@/components/app-controls-provider";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const STATUS_TEXT: Record<AppState["status"], string> = {
  Running: "Running",
  Starting: "Starting…",
  Stopping: "Stopping…",
  Stopped: "Stopped",
  "Needs setup": "Needs setup",
  Unhealthy: "Unhealthy",
  Error: "Error",
};

function appLabel(id: AppId): string {
  return hubApps.find((app) => app.slug === id)?.name ?? id;
}

function statusColorClass(status: AppState["status"]): string {
  if (status === "Error" || status === "Unhealthy") return "text-destructive";
  if (status === "Running") return "text-accent";
  return "text-muted-foreground";
}

export function AppControlsPanel() {
  const { state, loading, error, refresh, change } = useAppControls();
  const [confirming, setConfirming] = useState<AppId | null>(null);
  const [pending, setPending] = useState<AppId | null>(null);
  const [rowError, setRowError] = useState<{ id: AppId; message: string } | null>(null);

  const busy = pending !== null || !!state?.apps.some((app) => app.status === "Starting" || app.status === "Stopping");

  async function runChange(id: AppId, enabled: boolean) {
    setPending(id);
    setRowError(null);
    try {
      await change(id, enabled);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not update this app.";
      setRowError({ id, message });
      if (/changed|refresh/i.test(message)) refresh();
    } finally {
      setPending(null);
    }
  }

  function retry(app: AppState) {
    if (app.enabled) void runChange(app.id, true);
    else setConfirming(app.id);
  }

  const confirmingApp = confirming ? (state?.apps.find((app) => app.id === confirming) ?? null) : null;

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-9 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.03em]">App controls</h1>
          <p className="mt-2 max-w-[520px] text-[15px] leading-6 text-muted-foreground">
            These switches affect both family members. The Hub stays online.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium transition-colors duration-150 hover:bg-muted disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
        >
          <RefreshCw aria-hidden size={15} className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
          Refresh
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}

      {state ? (
        <ul className="mt-7 space-y-3">
          {state.apps.map((app) => {
            const label = appLabel(app.id);
            const rowBusy = busy || pending === app.id;
            return (
              <li key={app.id} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
                <div className="min-w-0">
                  <p className="font-semibold">{label}</p>
                  <p className={`mt-1 text-sm ${statusColorClass(app.status)}`}>{STATUS_TEXT[app.status]}</p>
                  {rowError?.id === app.id && (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {rowError.message}
                    </p>
                  )}
                  {app.status === "Error" && (
                    <button
                      type="button"
                      onClick={() => retry(app)}
                      disabled={rowBusy}
                      className={`mt-2 inline-flex min-h-11 items-center rounded-md border border-border px-3 text-xs font-medium transition-colors duration-150 hover:bg-muted disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
                    >
                      Retry
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={app.enabled}
                  aria-label={`${app.enabled ? "Stop" : "Start"} ${label}`}
                  disabled={rowBusy}
                  onClick={() => (app.enabled ? setConfirming(app.id) : void runChange(app.id, true))}
                  className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-1 text-xs font-semibold transition-colors duration-150 disabled:opacity-60 motion-reduce:transition-none ${app.enabled ? "bg-accent text-on-accent" : "bg-muted text-muted-foreground"} ${FOCUS_RING}`}
                >
                  <span aria-hidden>{app.enabled ? "On" : "Off"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-7 text-sm text-muted-foreground">
          {loading ? "Loading app controls…" : "App controls are unavailable."}
        </p>
      )}

      {confirmingApp && (
        <StopConfirmDialog
          label={appLabel(confirmingApp.id)}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void runChange(confirmingApp.id, false);
          }}
        />
      )}
    </div>
  );
}

function StopConfirmDialog({ label, onCancel, onConfirm }: { label: string; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmedRef = useRef(false);
  const titleId = useId();
  const descId = useId();

  // Native <dialog> gives a modal top layer, Escape-to-cancel and -- per the
  // HTML spec's close() steps -- automatic focus restoration to whatever
  // triggered showModal(), for free: no hand-rolled focus trap needed.
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onClose={() => {
        if (confirmedRef.current) onConfirm();
        else onCancel();
      }}
      className="max-w-[420px] rounded-xl border border-border bg-card p-6 text-foreground backdrop:bg-black/70"
    >
      <h2 id={titleId} className="text-lg font-semibold">
        Turn off {label}?
      </h2>
      <p id={descId} className="mt-2 text-sm text-muted-foreground">
        This ends any active analyses, backtests, or simulations in {label} for both of you. The Hub stays online.
      </p>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className={`min-h-11 rounded-md border border-border px-4 text-sm font-medium transition-colors duration-150 hover:bg-muted motion-reduce:transition-none ${FOCUS_RING}`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            confirmedRef.current = true;
            ref.current?.close();
          }}
          className={`min-h-11 rounded-md bg-destructive px-4 text-sm font-semibold text-on-destructive transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none ${FOCUS_RING}`}
        >
          Stop
        </button>
      </div>
    </dialog>
  );
}
