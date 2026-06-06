'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Presentation-only number count-up. Animates the DISPLAYED value from its
 * previous render to `value`; never alters the underlying data it's given.
 */
export function CountUp({ value, duration = 650, className }: { value: number; duration?: number; className?: string }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) { setDisplay(to); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) { raf = requestAnimationFrame(tick); } else { fromRef.current = to; }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <span className={className}>{display}</span>;
}
