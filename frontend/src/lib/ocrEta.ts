/** Anchored countdown ETA for local page OCR.

The browser reports one completion per OCR page. Each step anchors a
countdown (`anchorEtaSeconds` at `anchorAtMs`); rendering computes
`max(0, anchor - (now - anchorAt) / 1000)`. A later step re-anchors (up or
down); the per-second ticks always decrement.

The per-page estimate comes from measured throughput, not a fixed per-page
budget: LLM OCR speed depends heavily on the model, image size, and server.
*/

/**
 * Estimate the remaining seconds from measured per-page throughput.
 *
 * Returns `null` until at least one page has completed, since there is no
 * basis for an estimate before that.
 */
export function measureEtaSeconds(
	done: number,
	total: number,
	elapsedS: number
): number | null {
	if (!Number.isFinite(done) || !Number.isFinite(total) || !Number.isFinite(elapsedS)) return null;
	if (total <= 0 || done <= 0 || elapsedS < 0) return null;
	const perPage = elapsedS / done;
	return Math.max(0, perPage * Math.max(0, total - done));
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

/**
 * Format a remaining-time countdown (no leading `-`: the surrounding `left`
 * / player context already conveys countdown semantics).
 *
 * Shows `h:mm:ss` when the duration is an hour or more, otherwise `m:ss`
 * (e.g. `382:45` becomes `6:22:45`). Rounds to the nearest second first so
 * values like `119.6s` render as `2:00` rather than `1:60`.
 */
export function formatRemaining(totalSeconds: number): string {
	const total = Math.max(0, Math.round(totalSeconds));
	if (total >= 3600) {
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}
