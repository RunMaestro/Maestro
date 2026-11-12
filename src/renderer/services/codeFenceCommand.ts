/**
 * codeFenceCommand - run a shell code fence from an agent's reply in command
 * mode, as if the user had typed it after `!`.
 *
 * An agent that answers with a command (`curl ...`, `npm run build`) leaves the
 * user to copy it, enter command mode, paste and press Enter. The fence's Run
 * button collapses that into one click, and its Alt-click drops the command
 * into the composer in command mode instead, so editing it first is one gesture
 * away rather than a copy-paste.
 *
 * Same shape as `codexFollowup.ts`, for the same reason: `LogItem` renders
 * `<MarkdownRenderer>` at several call sites, and the thing that runs a command
 * for a tab (`dispatchShellCommand` plus the composer ref for a prefill) lives
 * at the top of the tree. So the click raises one app-level CustomEvent and a
 * single listener in `App.tsx` answers it.
 *
 * The request names the conversation the fence was drawn in, and the listener
 * CHECKS it against what is on screen through `resolveCodexFollowup()`: the
 * command is agent-authored, so a click that lands after the user switched away
 * degrades to a prefill in the composer they are looking at, never a run in a
 * conversation they are not.
 */

/** Event name the app-level listener in `App.tsx` answers. */
export const CODE_FENCE_COMMAND_EVENT = 'maestro:codeFenceCommand';

/** Which conversation a fence's Run button belongs to. */
export interface CodeFenceCommandTarget {
	sessionId: string;
	tabId: string;
}

export interface CodeFenceCommandRequest extends CodeFenceCommandTarget {
	/** The command line to run, already extracted from the fence body. */
	command: string;
	/** `'run'` executes it now; `'prefill'` loads it into the composer in command mode. */
	mode: 'run' | 'prefill';
}

/**
 * Ask the app to run (or prefill) a command from a code fence.
 *
 * Fire-and-forget: a no-op when nothing is listening.
 */
export function requestCodeFenceCommand(request: CodeFenceCommandRequest): void {
	window.dispatchEvent(
		new CustomEvent<CodeFenceCommandRequest>(CODE_FENCE_COMMAND_EVENT, {
			detail: { ...request },
		})
	);
}
