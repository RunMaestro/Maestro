// Wire types for the Claude TUI canary (src/main/agents/claude-tui-canary.ts),
// shared by the main process and `maestro-cli claude-canary`.

/** One finished canary turn. */
export interface ClaudeTuiCanaryResult {
	/** `claude --version` when the turn ran. */
	claudeVersion: string;
	/** Maestro's version when the turn ran; a new one re-runs the canary. */
	maestroVersion: string;
	checkedAt: number;
	durationMs: number;
	/** The CLAUDE_CONFIG_DIR the turn ran as. */
	configDir: string;
	ok: boolean;
	/** maestro-p's failure code (`startup_dialog_blocked`, `tui_exited`, ...) or `no_result`. */
	error?: string;
	exitCode: number | null;
	/** What Claude Code last showed, when maestro-p reported it. */
	screen?: string;
}

/** What one `check()` did: ran and produced a result, or did not run and why. */
export type ClaudeTuiCanaryRunOutcome =
	| { ran: true; result: ClaudeTuiCanaryResult }
	| { ran: false; reason: string; last?: ClaudeTuiCanaryResult };
