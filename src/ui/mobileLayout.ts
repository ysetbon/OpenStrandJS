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
//   2. apply ONE transform to the whole `.app` to (a) uniformly scale it to fit
//      the screen and (b) rotate it 90° when the phone is held in portrait so the
//      content is always horizontal.
//
// Because the transform is a single uniform scale (+ optional 90° rotation), the
// canvas hit-testing stays correct: InteractionHost.toScreen divides by the
// canvas's getBoundingClientRect (which already reflects the transform), and the
// rotation is handled explicitly via getAppRotationDeg().

// Desktop design space, in *layout* px. This is the 1440×900 "great" desktop
// window divided back out of its 0.65 page zoom (1440/0.65, 900/0.65): the exact
// layout box the chrome was authored for. Width grows to match the phone's aspect
// ratio so the canvas fills the screen (just like widening a desktop window);
// height is fixed so the chrome scales identically to desktop.
const REF_H = 1385;
const MIN_REF_W = 2215;

let mobileActive = false;
let rotated = false;
let immersiveArmed = false;

/** 0 on desktop / landscape phones, 90 when the content has been rotated to force
 *  landscape on a portrait phone. Read by InteractionHost for pointer mapping. */
export function getAppRotationDeg(): 0 | 90 {
  return rotated ? 90 : 0;
}

export function isMobileLayout(): boolean {
  return mobileActive;
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

function applyTransform(): void {
  const app = document.querySelector('.app') as HTMLElement | null;
  if (!app) return;

  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const portrait = sh > sw;

  // Long / short edge of the physical screen — the landscape content is always
  // laid out as (long × short) and rotated onto the screen when needed.
  const longSide = Math.max(sw, sh);
  const shortSide = Math.max(1, Math.min(sw, sh));
  // Widen the design box to the screen's aspect so the canvas fills the width
  // with no letterboxing (never narrower than the authored desktop width).
  const refW = Math.max(MIN_REF_W, Math.round((longSide / shortSide) * REF_H));

  app.style.position = 'fixed';
  app.style.top = '0';
  app.style.left = '0';
  app.style.width = `${refW}px`;
  app.style.height = `${REF_H}px`;
  app.style.transformOrigin = '0 0';

  if (!portrait) {
    // Already horizontal: uniform scale-to-fit, centered.
    const s = Math.min(sw / refW, sh / REF_H);
    const tx = (sw - refW * s) / 2;
    const ty = (sh - REF_H * s) / 2;
    app.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    rotated = false;
  } else {
    // Portrait phone: rotate the landscape content 90° clockwise so it fills the
    // screen horizontally. Maps design-local (0,0) to the on-screen top-right of
    // the rotated box; see InteractionHost.toScreen for the inverse mapping.
    const s = Math.min(sw / REF_H, sh / refW);
    const contentW = REF_H * s; // on-screen width after the 90° rotation
    const contentH = refW * s;
    const tx = (sw - contentW) / 2;
    const ty = (sh - contentH) / 2;
    app.style.transform = `translate(${tx + contentW}px, ${ty}px) rotate(90deg) scale(${s})`;
    rotated = true;
  }
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

  armImmersive();

  return () => {
    window.clearTimeout(t);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
  };
}
