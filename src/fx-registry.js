// Registries the compositor renders from (kept in their own module so effect modules can register
// without importing compositor.js, which imports them). compositor.js re-exports both.

/**
 * Pixel effects: effect type → renderer(a). `a` holds:
 *   canvas, ctx   the clip's frame so far (w × h stage pixels); draw into ctx in place or return a
 *                 new canvas of the same size (it is copied over the stage)
 *   w, h, v       stage size and the effect's values at this frame
 *   ps            stage pixels per SOURCE pixel (multiply source-pixel sizes by it)
 *   k             stage pixels per SEQUENCE pixel (positions / sizes given in sequence pixels)
 *   map(X, Y)     a sequence-space point → stage pixels (the clip's frame placed centred and fit,
 *                 before Motion; for a clip that fills the frame this is just X·k, Y·k)
 *   clip, fx      the clip and the effect object (fx lets a renderer evaluate params at other
 *                 times, e.g. for motion blur), tl clip-local time, t sequence time
 *   seq, comp     the sequence and the Compositor (comp.renderTrack(trackId, t) etc.)
 */
export const PIXEL_FX = {};

/** Transitions: type → (p, dir, W, H) → a plan (see transitionPlan in compositor.js). */
export const TRANSITION_PLANS = {};
