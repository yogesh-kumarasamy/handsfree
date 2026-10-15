import { useEffect, useState } from "react";
import type { TicketStatus } from "../engine/src/types";

/** Re-render the caller every `ms`, so relative times ("in 11 min", "3 min ago") stay current. */
export function useTick(ms = 15_000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function Logo({ size = 30 }: { size?: number }) {
  // Calm mark: a quiet path (you walk) and a moving dot (it runs).
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="hf-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4fa592" />
          <stop offset="1" stopColor="#2a6e60" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#hf-g)" />
      <path d="M12 44 C 22 44, 26 26, 36 26 S 48 36, 54 30" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="4" strokeLinecap="round" />
      <circle cx="44" cy="20" r="6" fill="#fff" />
    </svg>
  );
}

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      className={`toggle ${on ? "on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

const LABEL: Record<TicketStatus, string> = {
  queued: "Queued",
  running: "Running",
  manual: "With you",
  failed: "Failed",
  stopped: "Stopped",
  pr_draft: "Draft PR",
  pr_ready: "Ready for review",
  pr_ci_failed: "CI failing",
  pr_approved: "Approved",
  merged: "Merged",
  done: "Closed",
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className={`dot ${status === "running" ? "pulse" : ""}`} />
      {LABEL[status]}
    </span>
  );
}

export function ago(iso?: string) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return until(iso);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function until(iso?: string) {
  if (!iso) return "—";
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 30) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.round(s / 3600)} h`;
}

export function duration(from: string, to?: string) {
  const s = Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const Icon = {
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="6" rx="1.5" /><rect x="9" y="2" width="5" height="4" rx="1.5" />
      <rect x="2" y="10" width="5" height="4" rx="1.5" /><rect x="9" y="8" width="5" height="6" rx="1.5" />
    </svg>
  ),
  projects: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </svg>
  ),
  pause: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="3" height="9" rx="1" /><rect x="7" y="1.5" width="3" height="9" rx="1" /></svg>
  ),
  play: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.8-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z" /></svg>
  ),
  refresh: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg>
  ),
  plus: (
    <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.8"><path d="M6 1.5v9M1.5 6h9" /></svg>
  ),
};
