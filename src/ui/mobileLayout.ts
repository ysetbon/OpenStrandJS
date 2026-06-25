// Mobile (phone / small-touch) presentation layer.
//
// Goal: on a phone the editor must look EXACTLY like the desktop UI — same
// toolbar, same layer/group panels, same proportions — just scaled to fit, and
// always in a horizontal (landscape) orientation, with the browser's own chrome
// (address bar, tabs) hidden.
//
// How it works
// ------------
// The desktop chrome is laid out in a fixed "design" space and then shrunk to
// the visible window by the global `html { zoom: 0.65 }` rule. That zoom couples
// badly with a CSS transform, so on mobile we DISABLE the page zoom (html.mobile
// { zoom: 1 }) and instead:
//   1. size the `.app` box to the desktop DESIGN size in layout px (so every
//      component lays out byte-identically to the desktop), and
//   2. apply ONE transform to the whole `.app` to (a) scale it and (b) rotate it
//      90° when the phone is held in portrait so the content is always horizontal.
//
// Desktop buttons are tiny when the whole layout is shrunk to fit a phone, so the
// view opens at DEFAULT_ZOOM (150% of fit, like Ctrl-+ in a browser): the UI is
// bigger than the screen and the user PANS (two fingers) to reach the edges and
// PINCHES (two fingers) to change zoom. One finger still draws on the canvas.
// Zooming out bottoms out at fit-to-screen (the full overview).
//
// Because the whole transform is a single uniform scale (+ optional 90° rotation
// + pan translate), the canvas hit-testing stays correct: InteractionHost.toScreen
// divides by the canvas's getBoundingClientRect (which already reflects the live
// transform), and the rotation is handled explicitly via getAppRotationDeg().

// Desktop design space, in *layout* px. The base 2215×1385 box is the 1440×900
// "great" desktop window divided back out of its 0.65 page zoom (1440/0.65,
// 900/0.65): the exact layout box the chrome was authored for.
//
// On a phone that whole box is scaled to FIT the screen, which makes the chrome
// tiny. UI_SCALE shrinks the design box so the same fit fills the screen with the
// chrome UI_SCALE× bigger — the desktop UI lays out in less room (the canvas
// gives up the slack) and everything still fits with NO panning. 1.5 ≈ "the whole
// UI 150% bigger" while staying fully visible. Width grows to the phone's aspect
// ratio so the canvas fills the screen; height is fixed.
const UI_SCALE = 1.5;
const REF_H = Math.round(1385 / UI_SCALE);
const MIN_REF_W = Math.round(2215 / UI_SCALE);

// Extra user zoom on top of the fit scale, for pinching in CLOSER than the
// default fit. 1 = the default full-fit view (everything visible, UI_SCALE×
// bigger); MAX_ZOOM = closest pinch-in. Floor 1 so pinch-out always returns to
// the full UI — never smaller.
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

let mobileActive = false;
let rotated = false;
let immersiveArmed = false;

// Live view state, all in CSS/screen px. `userZoom` is the pinch factor over the
// fit scale; `panX/panY` is the on-screen position of the app's design-space (0,0).
let userZoom = DEFAULT_ZOOM;
let panX = 0;
let panY = 0;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 0 on desktop / landscape phones, 90 when the content has been rotated to force
 *  landscape on a portrait phone. Read by InteractionHost for pointer mapping. */
export function getAppRotationDeg(): 0 | 90 {
  return rotated ? 90 : 0;
}

export function isMobileLayout(): boolean {
  return mobileActive;
}

// True while a two-finger pinch/pan is in progress (latched from the moment a
// second finger lands until ALL fingers lift). InteractionHost reads this to
// abort/ignore one-finger drawing for the duration of an app gesture.
let gestureLatched = false;
export function isAppGestureActive(): boolean {
  return gestureLatched;
}

function detectMobile(): boolean {
  const q = new URLSearchParams(window.location.search);
  if (q.get('desktop') === '1' || q.get('mobile') === '0') return false;
  if (q.get('mobile') === '1' || q.get('forceMobile') === '1') return true;
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(hover: none)').matches;
  const ua = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent || '',
  );
  return coarse || ua;
}

// Fit-to-screen scale + widened design width for the current window. The design
// box is always laid out landscape (refW × REF_H); on a portrait phone it is
// rotated onto the screen, so the fit uses the swapped axes.
function fitMetrics(): { s: number; refW: number; portrait: boolean } {
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const portrait = sh > sw;
  const longSide = Math.max(sw, sh);
  const shortSide = Math.max(1, Math.min(sw, sh));
  const refW = Math.max(MIN_REF_W, Math.round((longSide / shortSide) * REF_H));
  const s = portrait ? Math.min(sw / REF_H, sh / refW) : Math.min(sw / refW, sh / REF_H);
  return { s, refW, portrait };
}

function applyTransform(): void {
  const app = document.querySelector('.app') as HTMLElement | null;
  if (!app) return;

  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const { s, refW, portrait } = fitMetrics();
  const eff = s * userZoom; // effective uniform scale

  app.style.position = 'fixed';
  app.style.top = '0';
  app.style.left = '0';
  app.style.width = `${refW}px`;
  app.style.height = `${REF_H}px`;
  app.style.transformOrigin = '0 0';

  if (!portrait) {
    // Landscape: scale by `eff` and position by (panX, panY). Clamp the pan so the
    // app always covers the screen when it is larger than it (no empty gaps), and
    // is centered on any axis where it is smaller (e.g. a letterboxed overview).
    const contentW = refW * eff;
    const contentH = REF_H * eff;
    panX = contentW >= sw ? clamp(panX, sw - contentW, 0) : (sw - contentW) / 2;
    panY = contentH >= sh ? clamp(panY, sh - contentH, 0) : (sh - contentH) / 2;
    app.style.transform = `translate(${panX}px, ${panY}px) scale(${eff})`;
    rotated = false;
  } else {
    // Portrait phone: rotate the landscape content 90° clockwise so it fills the
    // screen horizontally. Zoom still applies; pan is centered (the installed PWA
    // is orientation-locked landscape, so this path is a rare fallback).
    const contentW = REF_H * eff; // on-screen width after the 90° rotation
    const contentH = refW * eff;
    const tx = (sw - contentW) / 2;
    const ty = (sh - contentH) / 2;
    app.style.transform = `translate(${tx + contentW}px, ${ty}px) rotate(90deg) scale(${eff})`;
    rotated = true;
  }
}

// ---- Two-finger pinch-zoom + pan -------------------------------------------
// Tracked from `window` touch events so a pinch works over any part of the app
// (canvas, toolbar, panels). One finger is left entirely to the canvas/buttons.

let gesture:
  | { startDist: number; startCx: number; startCy: number; startZoom: number; startPanX: number; startPanY: number; s: number }
  | null = null;

const dist = (a: Touch, b: Touch) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

function onTouchStart(e: TouchEvent): void {
  if (e.touches.length < 2) return;
  const a = e.touches[0];
  const b = e.touches[1];
  const { s } = fitMetrics();
  gesture = {
    startDist: Math.max(1, dist(a, b)),
    startCx: (a.clientX + b.clientX) / 2,
    startCy: (a.clientY + b.clientY) / 2,
    startZoom: userZoom,
    startPanX: panX,
    startPanY: panY,
    s,
  };
  gestureLatched = true;
  e.preventDefault();
}

function onTouchMove(e: TouchEvent): void {
  if (!gesture || e.touches.length < 2) return;
  e.preventDefault();
  const a = e.touches[0];
  const b = e.touches[1];
  const cx = (a.clientX + b.clientX) / 2;
  const cy = (a.clientY + b.clientY) / 2;
  const newZoom = clamp(gesture.startZoom * (dist(a, b) / gesture.startDist), MIN_ZOOM, MAX_ZOOM);
  userZoom = newZoom;
  if (!rotated) {
    // Keep the design point that was under the initial centroid pinned under the
    // current centroid: focal zoom + pan in one. (panX,panY get clamped in apply.)
    const sb = gesture.s;
    const dpx = (gesture.startCx - gesture.startPanX) / (sb * gesture.startZoom);
    const dpy = (gesture.startCy - gesture.startPanY) / (sb * gesture.startZoom);
    panX = cx - dpx * (sb * newZoom);
    panY = cy - dpy * (sb * newZoom);
  }
  applyTransform();
}

function onTouchEnd(e: TouchEvent): void {
  if (e.touches.length < 2) gesture = null;
  // Stay latched until every finger is up, so the last lingering finger of a
  // pinch can't be mistaken for the start of a one-finger draw.
  if (e.touches.length === 0) gestureLatched = false;
}

// Best-effort "hide the browser chrome + lock to landscape" on the first user
// gesture (both require a user-activation on most browsers). Silent on failure —
// desktop browsers, iOS Safari (no Fullscreen/orientation lock) just keep the
// CSS-rotation fallback above.
function armImmersive(): void {
  if (immersiveArmed) return;
  immersiveArmed = true;
  const go = () => {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    try {
      const req = el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.();
      Promise.resolve(req)
        .then(() => {
          const orient = (screen as Screen & {
            orientation?: { lock?: (o: string) => Promise<void> };
          }).orientation;
          orient?.lock?.('landscape').catch(() => {});
        })
        .catch(() => {});
    } catch {
      /* fullscreen unavailable — ignore */
    }
    window.removeEventListener('pointerup', go);
    window.removeEventListener('touchend', go);
  };
  window.addEventListener('pointerup', go, { once: true });
  window.addEventListener('touchend', go, { once: true });
}

/** Wire up the mobile presentation. No-op (and leaves the desktop path fully
 *  untouched) when not on a small-touch device. Returns a cleanup fn. */
export function initMobileLayout(): () => void {
  if (!detectMobile()) return () => {};
  mobileActive = true;
  document.documentElement.classList.add('mobile');

  const onResize = () => applyTransform();
  applyTransform();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  // Some browsers settle the viewport a beat after rotation/chrome changes.
  const t = window.setTimeout(applyTransform, 300);

  window.addEventListener('touchstart', onTouchStart, { passive: false });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd);
  window.addEventListener('touchcancel', onTouchEnd);

  armImmersive();

  return () => {
    window.clearTimeout(t);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
  };
}
