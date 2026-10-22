// Open tool calls, for the run-mode idle watchdog.
//
// The watchdog measures transcript silence, but claude writes nothing to the
// transcript while a tool runs: a Bash `npm test`, a pre-push suite, or a
// subagent can keep the turn silent for many minutes. Measured on Pedsidian,
// turns were killed (exit 3) at the 300s budget while a Bash tool was still
// running and returned a few seconds later.
//
// A silent screen does not tell a running tool from a turn parked on a
// permission dialog: claude keeps animating its spinner in both. So a running
// tool only holds the watchdog off when nothing can be waiting on the user:
// claude was launched with permissions bypassed, and no open call is a tool
// that asks the user something (AskUserQuestion).

// Tools that park the TUI on a question to the user. ExitPlanMode is not here:
// run mode finalizes on it directly (see plan-mode.ts).
const USER_BLOCKING_TOOLS = new Set(['AskUserQuestion']);

export class OpenToolCalls {
	private readonly open = new Map<string, string>();

	/** Record every tool_use block of an assistant message. */
	noteAssistant(message: unknown): void {
		for (const block of contentBlocks(message)) {
			if (block.type === 'tool_use' && typeof block.id === 'string') {
				this.open.set(block.id, typeof block.name === 'string' ? block.name : '');
			}
		}
	}

	/** Close every call a tool_result row answers. */
	noteToolResult(message: unknown): void {
		for (const block of contentBlocks(message)) {
			if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
				this.open.delete(block.tool_use_id);
			}
		}
	}

	/**
	 * True when a tool call is open and none of the open calls can be waiting on
	 * the user. `permissionsBypassed` comes from {@link skipsPermissionPrompts}.
	 */
	runningUnattended(permissionsBypassed: boolean): boolean {
		if (!permissionsBypassed || this.open.size === 0) return false;
		for (const name of this.open.values()) {
			if (USER_BLOCKING_TOOLS.has(name)) return false;
		}
		return true;
	}
}

/** Whether claude's flags mean no tool call can stop on a permission dialog. */
export function skipsPermissionPrompts(claudeArgs: readonly string[]): boolean {
	for (let i = 0; i < claudeArgs.length; i += 1) {
		const arg = claudeArgs[i];
		if (arg === '--dangerously-skip-permissions') return true;
		if (arg === '--permission-mode=bypassPermissions') return true;
		if (arg === '--permission-mode' && claudeArgs[i + 1] === 'bypassPermissions') return true;
	}
	return false;
}

/**
 * Claude's flags with permission prompts bypassed, as maestro-p always runs.
 *
 * `claude -p` cannot show a permission dialog, so it never stops on one. The
 * TUI can, and nothing answers it: the turn sat on the dialog until the idle
 * watchdog failed it. Bypassing makes a TUI turn run tools the way a print turn
 * does. An explicit `--permission-mode` is left alone, because `plan` is how a
 * caller asks for a read-only turn, and bypassing would lift that.
 */
export function withPermissionBypass(claudeArgs: readonly string[]): string[] {
	const args = [...claudeArgs];
	if (skipsPermissionPrompts(args)) return args;
	if (args.some((arg) => arg === '--permission-mode' || arg.startsWith('--permission-mode='))) {
		return args;
	}
	args.push('--dangerously-skip-permissions');
	return args;
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
	if (!message || typeof message !== 'object') return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}
