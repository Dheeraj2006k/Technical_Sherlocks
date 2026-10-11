"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeTeamChannel } from "@/lib/realtime-client.mjs";
import type { Act, ConnectionMode, GameState, Notify } from "./types";
import { post } from "./components/api";
import Game, { UnlockOverlay, type Overlay } from "./components/Game";
import Landing from "./components/Landing";
import { Spinner, ToastRegion, type ToastItem } from "./components/ui";

const POLL_MS = 3000; // used when realtime is unavailable or disconnected
const POLL_LIVE_MS = 20000; // safety net while the realtime socket is up (pings do the real work)

// Public by design (anon key); pings carry no data and the channel name is an unguessable per-team token.
const RT_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const RT_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const phaseOf = (s: GameState["state"]) => (s === "PHASE_1" ? 1 : s === "PHASE_2" ? 2 : s === "PHASE_3" ? 3 : s === "FINAL_DEDUCTION" ? 4 : 0);

export default function App() {
  const [snap, setSnap] = useState<{ gs: GameState; at: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(false);
  const [connOk, setConnOk] = useState(true);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [delta, setDelta] = useState<{ n: number; id: number } | null>(null);
  const prev = useRef<GameState | null>(null);
  const channel = snap?.gs.realtime_channel ?? null;

  const notify = useCallback<Notify>((tone, text) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (r.status === 401) {
        prev.current = null;
        setSnap(null);
        setConnOk(true);
      } else if (r.ok) {
        const g = (await r.json()) as GameState;
        const p = prev.current;
        if (p) {
          if (p.state !== g.state) {
            const ph = phaseOf(g.state);
            if (ph > 0) {
              setOverlay({
                id: Date.now(),
                kind: g.state === "PHASE_1" ? "open" : g.state === "FINAL_DEDUCTION" ? "final" : "phase",
                phase: ph,
                tables: g.unlocked_tables.filter((t) => !p.unlocked_tables.includes(t)),
              });
            }
          }
          if (g.scores.total_pts > p.scores.total_pts) setDelta({ n: g.scores.total_pts - p.scores.total_pts, id: Date.now() });
        }
        prev.current = g;
        setSnap({ gs: g, at: Date.now() });
        setConnOk(true);
      } else {
        setConnOk(false);
      }
    } catch {
      setConnOk(false); // keep the last known state on network errors
    }
    setLoaded(true);
  }, []);

  const signedIn = snap !== null;
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    // Only poll once signed in: visitors on the landing page make one check, not one every 3 seconds.
    if (!signedIn) return () => clearTimeout(first);
    const t = setInterval(refresh, live ? POLL_LIVE_MS : POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh, live, signedIn]);

  // Realtime: a ping means "something changed" -> refetch authoritative state. On every (re)connect
  // we refetch too, because pings may have been missed while the socket was down.
  useEffect(() => {
    if (!channel || !RT_URL || !RT_KEY) return;
    const sub = subscribeTeamChannel({
      url: RT_URL,
      apikey: RT_KEY,
      token: channel,
      onPing: refresh,
      onStatus: (s) => {
        setLive(s === "connected");
        refresh();
      },
    });
    return () => {
      sub.close();
      setLive(false);
    };
  }, [channel, refresh]);

  const act = useCallback<Act>(
    async (path, body) => {
      const r = await post(path, body);
      refresh();
      return r;
    },
    [refresh],
  );

  const leave = useCallback(async () => {
    await post("/api/logout");
    prev.current = null;
    refresh();
  }, [refresh]);

  const mode: ConnectionMode = !connOk ? "reconnecting" : live ? "live" : "polling";
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const clearOverlay = useCallback(() => setOverlay(null), []);

  let body;
  if (!loaded) {
    body = (
      <main id="main" className="splash grid-bg">
        <Spinner label="Connecting to investigation server…" />
      </main>
    );
  } else if (!snap) {
    body = <Landing onJoined={refresh} />;
  } else {
    body = <Game gs={snap.gs} at={snap.at} mode={mode} delta={delta} act={act} notify={notify} onLeave={leave} />;
  }

  return (
    <>
      {body}
      <UnlockOverlay overlay={overlay} onDone={clearOverlay} />
      <ToastRegion toasts={toasts} dismiss={dismiss} />
    </>
  );
}
