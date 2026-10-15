import type { PrEvent } from "./types";

/** Internal, once-per-PR lifecycle events (review ready, merge nudge, merged, fix rounds exhausted). Not on the SSE stream. */
export class PrEvents {
  private subs = new Set<(e: PrEvent) => void>();
  on(fn: (e: PrEvent) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(e: PrEvent) {
    for (const s of this.subs) {
      try {
        s(e);
      } catch {
        /* a subscriber must never break the check loop */
      }
    }
  }
}
