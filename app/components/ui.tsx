"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

export const initials = (name: string) =>
  name
    .replace(/^(Dr\.|Prof\.|Sir|Lord|Lady|Nurse|Captain|Madame|Judge)\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

export function hueOf(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ name, size = 40, online }: { name: string; size?: number; online?: boolean }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38), "--h": hueOf(name) } as CSSProperties;
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {initials(name)}
      {online !== undefined && <i className={`presence ${online ? "on" : "off"}`} />}
    </span>
  );
}

type IconName = "magnifier" | "folder" | "pin" | "check" | "lock" | "user" | "clock" | "bolt" | "alert" | "copy" | "trophy" | "scales";

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: false };
  switch (name) {
    case "magnifier":
      return (<svg {...p}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></svg>);
    case "folder":
      return (<svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>);
    case "pin":
      return (<svg {...p}><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" /><path d="M12 14v7" /></svg>);
    case "check":
      return (<svg {...p}><path d="m4 12.5 5 5L20 6.5" /></svg>);
    case "lock":
      return (<svg {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>);
    case "user":
      return (<svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>);
    case "clock":
      return (<svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
    case "bolt":
      return (<svg {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>);
    case "alert":
      return (<svg {...p}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17.5v.01" /></svg>);
    case "copy":
      return (<svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>);
    case "trophy":
      return (<svg {...p}><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M12 14v4M8 21h8" /></svg>);
    case "scales":
      return (<svg {...p}><path d="M12 4v16M6 20h12M5 7h14" /><path d="m5 7-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" /></svg>);
  }
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <i aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
  tone = "default",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  tone?: "default" | "danger";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal ${tone}`} aria-labelledby="modal-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="modal-body">
        <h2 id="modal-title" className="modal-title">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export type ToastItem = { id: number; tone: "success" | "error" | "info"; text: string };

export function ToastRegion({ toasts, dismiss }: { toasts: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      <div aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            <span>{t.text}</span>
            <button type="button" className="toast-x" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusPill({ tone, children }: { tone: "green" | "amber" | "red" | "cyan" | "muted"; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
