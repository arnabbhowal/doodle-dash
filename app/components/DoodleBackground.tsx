'use client';

import { useEffect, useRef } from 'react';

// ── Interactive doodle-field background ───────────────────────────────────────
// A full-area <canvas> of floating doodle PNGs (served as WebP from
// /public/bg-doodles). Each doodle is a particle that drifts slowly and bounces
// off the edges; when the pointer comes within REPULSION_RADIUS the doodles
// scatter away and then smoothly ease back to their float. Dependency-free,
// single requestAnimationFrame loop, DPR-capped, pauses when the tab is hidden.
//
// Tunables — adjust freely:
const IMG_BASE = '/bg-doodles';   // public/bg-doodles/doodle_001.webp ... _135.webp
const IMG_COUNT = 135;
const PARTICLE_COUNT = 135;       // how many doodles on screen (<= IMG_COUNT uses distinct images)
const BASE_SPEED = 0.25;          // drift speed in CSS px/frame
const REPULSION_RADIUS = 150;     // px around the pointer that pushes doodles
const REPULSION_FORCE = 1.8;      // strength of the scatter impulse
const PUSH_DAMPING = 0.9;         // 0..1 — how quickly the scatter eases back (lower = snappier return)
const MIN_SCALE = 0.22;           // doodle size range (source art is ~175px)
const MAX_SCALE = 0.5;
const ROTATION_SPEED = 0.0015;    // max radians/frame of gentle spin
const MAX_DPR = 2;                // cap the backing-store resolution for perf

interface Particle {
  x: number; y: number;           // position (CSS px)
  vx: number; vy: number;         // constant drift velocity (reversed on bounce)
  pvx: number; pvy: number;       // transient repulsion velocity (decays each frame)
  scale: number;
  rot: number; vr: number;        // rotation + rotational velocity
  img: HTMLImageElement;
}

export function DoodleBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let W = 0, H = 0;
    let raf = 0;
    let running = true;
    const particles: Particle[] = [];
    const mouse = { x: -9999, y: -9999 };

    // Preload images (WebP). Particles draw only once their image is decoded.
    const imgs: HTMLImageElement[] = [];
    for (let i = 1; i <= IMG_COUNT; i++) {
      const img = new Image();
      img.src = `${IMG_BASE}/doodle_${String(i).padStart(3, '0')}.webp`;
      imgs.push(img);
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // work in CSS pixels
      // Keep particles inside the new bounds.
      for (const p of particles) {
        p.x = Math.min(Math.max(p.x, 0), W);
        p.y = Math.min(Math.max(p.y, 0), H);
      }
    };

    const init = () => {
      resize();
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const angle = Math.random() * Math.PI * 2;
        particles.push({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: Math.cos(angle) * BASE_SPEED,
          vy: Math.sin(angle) * BASE_SPEED,
          pvx: 0, pvy: 0,
          scale: MIN_SCALE + Math.random() * (MAX_SCALE - MIN_SCALE),
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 2 * ROTATION_SPEED,
          img: imgs[i % imgs.length],
        });
      }
    };

    const step = () => {
      ctx.clearRect(0, 0, W, H);
      for (const p of particles) {
        // Pointer repulsion (only the transient pvx/pvy; eases back via damping).
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < REPULSION_RADIUS * REPULSION_RADIUS) {
          const d = Math.sqrt(d2) || 0.0001;
          const f = (1 - d / REPULSION_RADIUS) * REPULSION_FORCE;
          p.pvx += (dx / d) * f;
          p.pvy += (dy / d) * f;
        }

        p.x += p.vx + p.pvx;
        p.y += p.vy + p.pvy;
        p.pvx *= PUSH_DAMPING;
        p.pvy *= PUSH_DAMPING;
        p.rot += p.vr;

        // Soft edge bounce (radius from the scaled image's half-width).
        const r = (p.img.naturalWidth || 175) * p.scale * 0.5;
        if (p.x < r) { p.x = r; p.vx = Math.abs(p.vx); p.pvx = Math.abs(p.pvx); }
        else if (p.x > W - r) { p.x = W - r; p.vx = -Math.abs(p.vx); p.pvx = -Math.abs(p.pvx); }
        if (p.y < r) { p.y = r; p.vy = Math.abs(p.vy); p.pvy = Math.abs(p.pvy); }
        else if (p.y > H - r) { p.y = H - r; p.vy = -Math.abs(p.vy); p.pvy = -Math.abs(p.pvy); }

        if (p.img.complete && p.img.naturalWidth) {
          const w = p.img.naturalWidth * p.scale;
          const h = p.img.naturalHeight * p.scale;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.drawImage(p.img, -w / 2, -h / 2, w, h);
          ctx.restore();
        }
      }
      raf = requestAnimationFrame(step);
    };

    const onMove = (e: PointerEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; };
    const onLeave = () => { mouse.x = -9999; mouse.y = -9999; };
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(step);
      }
    };

    init();
    raf = requestAnimationFrame(step);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerout', onLeave);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onLeave);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
