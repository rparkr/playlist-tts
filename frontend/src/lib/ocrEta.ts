/** Anchored countdown ETA for OCR progress.

The backend emits a fresh `eta` (seconds) about once per second via SSE
`progress` / `keepalive` events. Between those steps the UI must tick the
displayed value *down* by 1s every second — never recompute an ETA from
`elapsed / done`, which counts *up* while `done` is stalled.

Model: each incoming step anchors a countdown (`anchorEtaSeconds` at
`anchorAtMs`). Rendering computes `max(0, anchor - (now - anchorAt) / 1000)`.
A later step re-anchors (up or down); the per-second ticks always decrement.
*/

/** Seconds of VLM time budgeted per page — mirrors backend `OCR_SECONDS_PER_PAGE`. */
export const OCR_SECONDS_PER_PAGE = 2.6;
/** Fixed per-job overhead — mirrors backend `OCR_FIXED_OVERHEAD_S`. */
export const OCR_FIXED_OVERHEAD_S = 8.0;

/** Estimate whole-job seconds from page count. */
export function estimateTotalSeconds(totalPages: number): number {
	return Math.max(0, totalPages) * OCR_SECONDS_PER_PAGE + OCR_FIXED_OVERHEAD_S;
}

/**
 * Fallback ETA when a step carries no server `eta` (initial SSE event,
 * polling fallback). Countdown-style: total estimate minus elapsed.
 *
 * Return `null` when no meaningful estimate exists yet.
 */
export function fallbackEtaSeconds(done: number, total: number, elapsedS: number): number | null {
	if (!Number.isFinite(done) || !Number.isFinite(total) || !Number.isFinite(elapsedS)) return null;
	if (total <= 0 || done <= 0 || elapsedS < 0) return null;
	return Math.max(0, estimateTotalSeconds(total) - elapsedS);
}

/**
 * Pick the anchor for a newly arrived progress step: prefer the server
 * `eta` when present, otherwise fall back to the countdown estimate.
 */
export function resolveAnchoredEta(
	eventEta: unknown,
	done: number,
	total: number,
	elapsedS: number
): number | null {
	if (typeof eventEta === 'number' && Number.isFinite(eventEta)) return Math.max(0, eventEta);
	return fallbackEtaSeconds(done, total, elapsedS);
}

/** Apply countdown ticks to an anchor. Always non-increasing in `nowMs`. */
export function tickDownEta(anchorEtaSeconds: number, anchorAtMs: number, nowMs: number): number {
	return Math.max(0, anchorEtaSeconds - Math.max(0, nowMs - anchorAtMs) / 1000);
}

/** Format seconds as `m:ss` for display. */
export function formatEta(totalSeconds: number): string {
	const total = Math.max(0, Math.round(totalSeconds));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}
