/**
 * Detect the `<!-- maestro:halt -->` early-exit marker in a document.
 *
 * Agents write this marker into the current Auto Run document to abort the
 * entire playbook (skipping all remaining tasks in the current document and
 * all subsequent documents). The optional reason after the colon is surfaced
 * in the History panel and JSONL `halt` event.
 *
 * Accepts:
 *   <!-- maestro:halt -->
 *   <!-- maestro:halt: brief reason here -->
 *
 * Match is case-insensitive on the keyword to tolerate agent variations,
 * but the literal token `maestro:halt` is required to keep false positives
 * effectively zero.
 *
 * Lives in `shared/` so both the CLI batch processor and the desktop renderer's
 * Auto Run loop apply the exact same contract - the default Auto Run prompt and
 * the in-app help modal advertise this marker to agents regardless of where the
 * run is driven from.
 */
export function detectHaltMarker(content: string): { halted: boolean; reason?: string } {
	const match = content.match(/<!--\s*maestro:halt\s*(?::\s*([^>]*?))?\s*-->/i);
	if (!match) return { halted: false };
	const reason = match[1]?.trim();
	return { halted: true, reason: reason || undefined };
}
