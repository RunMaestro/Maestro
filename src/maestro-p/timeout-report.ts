// Stderr reports for run-mode failures that leave claude parked on screen.
//
// A timeout is the one failure where maestro-p itself knows nothing about the
// cause: claude simply stopped writing to its transcript. The TUI screen is
// the only evidence of why (a tool-permission prompt, a modal, a hung tool or
// API call each look different), and it is gone the moment finalize() quits
// the TUI. So every timeout path writes the last screenful to stderr before
// finalizing, which makes the failure diagnosable from the caller's log alone.
// All of them share this one format so a log scraper matches a single header.

/**
 * Build a stderr report: the failure message, then the ANSI-stripped screen
 * tail under a fixed header. Output is newline-terminated.
 */
export function formatScreenTailReport(message: string, screenTail: string): string {
	return (
		`maestro-p: ${message}\n` +
		`maestro-p: last screen at timeout (ANSI-stripped tail):\n${screenTail}\n`
	);
}

/**
 * The message for an idle-watchdog trip: transcript output stopped for longer
 * than `--max-wait`, typically mid-turn after a tool call.
 */
export function idleTimeoutMessage(idleMs: number, maxWaitSeconds: number): string {
	const idleSeconds = Math.round(idleMs / 1000);
	return `no transcript output for ${idleSeconds}s (--max-wait ${maxWaitSeconds}s) - claude stopped writing to its transcript, likely parked on a permission prompt, a modal, or a hung tool or API call. Failing with timeout.`;
}
