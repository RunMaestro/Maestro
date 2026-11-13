// Live response progress, for the run-mode idle watchdog.
//
// The watchdog measures transcript silence, but claude writes a transcript row
// only when a whole content block is finished. One long block (minutes of
// thinking, or a Write whose input is a large file) therefore streams for
// minutes with ZERO transcript bytes, and the turn was killed at the 300s
// budget while the model was still answering. Observed 2026-11-13: a turn went
// silent 45s after a screenshot read and was ended at exactly 300s.
//
// The spinner is no help on its own: claude animates its glyph and elapsed
// clock whether the stream is flowing or hung. Its token counter is the honest
// signal. It reads `✢ Cooking… (9s · ↓ 420 tokens)` and climbs as tokens
// arrive; a hung request leaves it frozen. So a CHANGE in that count is
// progress, and an unchanged count is the same silence the watchdog already
// times out.

/**
 * `↓ 420 tokens`, `↓ 4.3k tokens`, `↑ 1,204 tokens`. Both arrows: either count
 * moving means bytes are crossing the wire.
 */
const STREAM_TOKENS_RE = /[↓↑]\s*([\d][\d.,]*)\s*([kKmM])?\s*tokens\b/g;

/**
 * The LAST token count painted on `screen` (the newest spinner frame), or null
 * when none is shown.
 */
export function parseStreamTokenCount(screen: string): number | null {
	let last: RegExpExecArray | null = null;
	STREAM_TOKENS_RE.lastIndex = 0;
	for (let match = STREAM_TOKENS_RE.exec(screen); match; match = STREAM_TOKENS_RE.exec(screen)) {
		last = match;
	}
	if (!last) return null;
	const value = Number(last[1].replace(/,/g, ''));
	if (!Number.isFinite(value)) return null;
	const unit = last[2]?.toLowerCase();
	const scale = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
	return Math.round(value * scale);
}

/**
 * Remembers the last token count seen and when it last CHANGED. The first
 * sighting is only a baseline: a count that was already on screen proves
 * nothing until a later sample differs from it.
 */
export class StreamProgress {
	private lastCount: number | null = null;
	private lastProgressAt = 0;

	observe(count: number | null, now: number): void {
		if (count === null) return;
		if (this.lastCount !== null && count !== this.lastCount) this.lastProgressAt = now;
		this.lastCount = count;
	}

	/** Epoch ms of the last observed change, or 0 when none has been seen. */
	getLastProgressAt(): number {
		return this.lastProgressAt;
	}
}
