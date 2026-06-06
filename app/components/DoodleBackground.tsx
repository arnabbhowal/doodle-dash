'use client';

import { useEffect, useRef } from 'react';

// ── Interactive doodle-field background ───────────────────────────────────────
// A full-area <canvas> of floating doodle PNGs (served as WebP from
// /public/bg-doodles). Each doodle is a particle with a circular collision
// boundary: they drift slowly, bounce off each other (no overlap) and the edges.
// When the pointer comes within REPULSION_RADIUS the doodles scatter away and
// then ease back. The on-screen COUNT scales with the viewport area so small /
// mobile screens aren't over-packed (which made doodles ping around), and a hard
// MAX_SPEED cap means collisions/repulsion can never fling anything fast. Single
// requestAnimationFrame loop, DPR-capped, pauses when the tab is hidden.
//
// Tunables — adjust freely:
const IMG_BASE = '/bg-doodles';        // public/bg-doodles/doodle_001.webp ... _135.webp
const IMG_COUNT = 135;
const AREA_PER_DOODLE = 8000;          // viewport px² per doodle (lower = denser)
const MIN_PARTICLES = 16;              // floor on tiny screens
const MAX_PARTICLES = 300;             // ceiling; above IMG_COUNT (135) extra particles
                                       //   reuse/duplicate images to fill large screens
const BASE_SPEED = 0.2;                // drift speed in CSS px/frame
const MAX_SPEED = 4;                   // hard cap on per-frame movement (anti-fling)
const DRIFT_SPEED_CAP = BASE_SPEED * 2.5; // keep the resting drift calm after bounces
const REPULSION_RADIUS = 150;          // px around the pointer that pushes doodles
const REPULSION_FORCE = 1.6;           // strength of the scatter impulse
const PUSH_DAMPING = 0.9;              // 0..1 — how quickly the scatter eases back
const MIN_SCALE = 0.4;                 // doodle size range (source art is ~175px)
const MAX_SCALE = 0.7;
const COLLISION_RADIUS_FACTOR = 0.45;  // collision circle = imageSize * scale * this
const ROTATION_SPEED = 0.001;          // max radians/frame of gentle spin
const MAX_DPR = 2;                     // cap the backing-store resolution for perf

interface Particle {
  x: number; y: number;           // position (CSS px)
  vx: number; vy: number;         // constant drift velocity (reversed on bounce)
  pvx: number; pvy: number;       // transient repulsion velocity (decays each frame)
  scale: number;
  rot: number; vr: number;        // rotation + rotational velocity
  r: number;                      // collision radius (recomputed each frame)
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
    let imgSeq = 0; // cycles through images as particles are added
    const particles: Particle[] = [];
    const mouse = { x: -9999, y: -9999 };

    // Preload images (WebP). Particles draw only once their image is decoded.
    const imgs: HTMLImageElement[] = [];
    for (let i = 1; i <= IMG_COUNT; i++) {
      const img = new Image();
      img.src = `${IMG_BASE}/doodle_${String(i).padStart(3, '0')}.webp`;
      imgs.push(img);
    }

    const targetCount = () =>
      Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round((W * H) / AREA_PER_DOODLE)));

    const makeParticle = (): Particle => {
      const angle = Math.random() * Math.PI * 2;
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx: Math.cos(angle) * BASE_SPEED,
        vy: Math.sin(angle) * BASE_SPEED,
        pvx: 0, pvy: 0,
        scale: MIN_SCALE + Math.random() * (MAX_SCALE - MIN_SCALE),
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 2 * ROTATION_SPEED,
        r: 0,
        img: imgs[imgSeq++ % IMG_COUNT],
      };
    };

    // Add/remove particles so the count matches the current viewport density.
    const syncCount = () => {
      const target = targetCount();
      while (particles.length < target) particles.push(makeParticle());
      while (particles.length > target) particles.pop();
    };

    const resizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // work in CSS pixels
      for (const p of particles) {
        p.x = Math.min(Math.max(p.x, 0), W);
        p.y = Math.min(Math.max(p.y, 0), H);
      }
    };

    const step = () => {
      ctx.clearRect(0, 0, W, H);

      // 1. Pointer repulsion + integrate (speed-capped) + collision radius.
      for (const p of particles) {
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < REPULSION_RADIUS * REPULSION_RADIUS) {
          const d = Math.sqrt(d2) || 0.0001;
          const f = (1 - d / REPULSION_RADIUS) * REPULSION_FORCE;
          p.pvx += (dx / d) * f;
          p.pvy += (dy / d) * f;
        }

        // Keep the resting drift calm even after many bounces.
        const vmag2 = p.vx * p.vx + p.vy * p.vy;
        if (vmag2 > DRIFT_SPEED_CAP * DRIFT_SPEED_CAP) {
          const s = DRIFT_SPEED_CAP / Math.sqrt(vmag2);
          p.vx *= s; p.vy *= s;
        }

        // Hard cap on the actual per-frame movement so nothing can fling fast.
        let mx = p.vx + p.pvx;
        let my = p.vy + p.pvy;
        const m2 = mx * mx + my * my;
        if (m2 > MAX_SPEED * MAX_SPEED) {
          const s = MAX_SPEED / Math.sqrt(m2);
          mx *= s; my *= s;
        }
        p.x += mx;
        p.y += my;
        p.pvx *= PUSH_DAMPING;
        p.pvy *= PUSH_DAMPING;
        p.rot += p.vr;
        p.r = (p.img.naturalWidth || 175) * p.scale * COLLISION_RADIUS_FACTOR;
      }

      // 2. Pairwise collisions: separate overlaps + elastic bounce along the normal.
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const minDist = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 < minDist * minDist) {
            let d = Math.sqrt(d2);
            if (d < 0.0001) { // exact overlap — nudge in a random direction
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d = Math.sqrt(dx * dx + dy * dy) || 1;
            }
            const nx = dx / d;
            const ny = dy / d;
            const overlap = (minDist - d) * 0.5;
            a.x -= nx * overlap; a.y -= ny * overlap;
            b.x += nx * overlap; b.y += ny * overlap;
            const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (rel < 0) {
              a.vx += rel * nx; a.vy += rel * ny;
              b.vx -= rel * nx; b.vy -= rel * ny;
            }
          }
        }
      }

      // 3. Edge bounce (use the visual half-size so doodles stay fully on-screen).
      for (const p of particles) {
        const hw = (p.img.naturalWidth || 175) * p.scale * 0.5;
        const hh = (p.img.naturalHeight || 171) * p.scale * 0.5;
        if (p.x < hw) { p.x = hw; p.vx = Math.abs(p.vx); p.pvx = Math.abs(p.pvx); }
        else if (p.x > W - hw) { p.x = W - hw; p.vx = -Math.abs(p.vx); p.pvx = -Math.abs(p.pvx); }
        if (p.y < hh) { p.y = hh; p.vy = Math.abs(p.vy); p.pvy = Math.abs(p.pvy); }
        else if (p.y > H - hh) { p.y = H - hh; p.vy = -Math.abs(p.vy); p.pvy = -Math.abs(p.pvy); }
      }

      // 4. Draw.
      for (const p of particles) {
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
    let resizeTimer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      resizeCanvas();                          // keep the canvas crisp immediately
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncCount, 160); // re-thin/-fill the count after settling
    };
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(step);
      }
    };

    resizeCanvas();
    syncCount();
    raf = requestAnimationFrame(step);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerout', onLeave);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
