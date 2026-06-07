'use client';

import { useEffect } from 'react';
import { BrutalButton } from './BrutalButton';

// Route-segment error boundary UI (used by app/host/[code]/error.tsx and
// app/play/[code]/error.tsx). A transient client-side exception used to show
// Next's black "Application error" screen and force a manual refresh. Instead we
// catch it here and auto-recover with a reload (the same thing a refresh does:
// reconnect + re-sync from the DB), guarded against reload loops so a persistent
// error falls back to a manual button.
export default function SegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[segment error]', error);
    const key = 'dd-err-reload-at';
    const last = Number(sessionStorage.getItem(key) || '0');
    const now = Date.now();
    // Only auto-reload if we haven't just done so (prevents a reload loop when an
    // error recurs immediately on mount).
    if (now - last > 10000) {
      sessionStorage.setItem(key, String(now));
      const t = setTimeout(() => window.location.reload(), 1000);
      return () => clearTimeout(t);
    }
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--canvas)]">
      <div className="text-center flex flex-col items-center gap-5 max-w-sm">
        <div className="spinner" style={{ margin: 0 }} />
        <h1 className="font-display font-black uppercase tracking-wide text-3xl text-white">Reconnecting…</h1>
        <p className="font-display text-white/60">A hiccup on the screen — recovering automatically. Tap below if it doesn&apos;t.</p>
        <BrutalButton color="magenta" size="lg" onClick={() => window.location.reload()}>
          Reload
        </BrutalButton>
      </div>
    </div>
  );
}
