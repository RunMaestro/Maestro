/**
 * AI command mode: shared, process-agnostic pieces.
 *
 * AI command mode is the second rung of the composer's bang ladder (see
 * `renderer/utils/shellCommandInput.ts`). The user describes what they want,
 * the tab's own model returns ONE command line, and Maestro shows it for a
 * yes/no before running it exactly like a typed `!` command.
 *
 * The two jobs here - describing the host the command will run on, and pulling
 * a command line back out of whatever the model actually printed - are pure
 * string work with no Electron or DOM dependency, so they live in `shared/` and
 * are unit-testable without booting either process.
 */

/**
 * How long to wait for the model before giving up.
 *
 * Short by one-shot standards: the user is sitting on a spinner in the composer
 * with a blinking caret, and a request that takes longer than this is better
 * reported as a failure they can retry than left hanging. Tool access is off
 * for this turn, so there is no investigation phase to wait through.
 */
export const AI_COMMAND_TIMEOUT_MS = 90 * 1000;

/** Facts about where the proposed command will actually run. */
export interface AiCommandHost {
	/** Node's `process.platform` value for the machine that runs the command. */
	platform: NodeJS.Platform | string;
	/** Kernel/OS release string, when known. */
	release?: string;
	/** Shell the command will be handed to (`/bin/zsh`, `powershell.exe`, ...). */
	shell: string;
	/** Directory the command starts in. */
	cwd: string;
	/** Whether that directory is a git repository. */
	isGitRepo?: boolean;
	/** SSH remote name when the agent runs remotely, else undefined. */
	remoteName?: string;
}

/** Human-readable OS name for the prompt. */
export function describePlatform(platform: string, release?: string): string {
	const name =
		platform === 'darwin'
			? 'macOS'
			: platform === 'win32'
				? 'Windows'
				: platform === 'linux'
					? 'Linux'
					: platform;
	return release ? `${name} (${platform} ${release})` : `${name} (${platform})`;
}

/**
 * Fill the `ai-command` prompt template with the host facts and the request.
 *
 * Substitution is a plain replace rather than the template-variable engine
 * because this prompt is never user-authored with arbitrary variables - it has
 * a fixed, documented set, and the user request is injected LAST so a request
 * that happens to contain `{{CWD}}` cannot rewrite the environment block above
 * it.
 */
export function buildAiCommandPrompt(
	template: string,
	host: AiCommandHost,
	request: string
): string {
	const remoteLine = host.remoteName
		? `- Remote: this command runs on the SSH remote "${host.remoteName}", not on the local machine`
		: '';

	return template
		.replace(/\{\{OS\}\}/g, describePlatform(host.platform, host.release))
		.replace(/\{\{SHELL\}\}/g, host.shell || 'unknown')
		.replace(/\{\{CWD\}\}/g, host.cwd)
		.replace(/\{\{IS_GIT_REPO\}\}/g, host.isGitRepo ? 'yes' : 'no')
		.replace(/\{\{REMOTE_LINE\}\}/g, remoteLine)
		.replace(/\{\{USER_REQUEST\}\}/g, request);
}

/** Lines a model adds around an answer that are never part of the command. */
const NOISE_LINE = /^(?:here(?:'s| is)\b|the command\b|command:|reply:|answer:)/i;

/**
 * Pull one command line out of a model reply.
 *
 * The prompt asks for a bare line and most replies are exactly that, but models
 * reach for a fenced block or a `$` prompt often enough that stripping them is
 * cheaper than a retry - and a stray backtick pasted into a shell is a syntax
 * error, not a near miss. Returns null when nothing usable is left, which the
 * caller surfaces as a failed suggestion rather than proposing an empty run.
 */
export function extractCommandLine(raw: string): string | null {
	let text = (raw || '').trim();
	if (!text) return null;

	// A fenced block, if present, IS the answer - prose outside it is commentary.
	const fence = text.match(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/);
	if (fence) text = fence[1];

	for (const line of text.split('\n')) {
		let candidate = line.trim();
		if (!candidate) continue;
		if (NOISE_LINE.test(candidate)) continue;
		// `` `git status` `` and `$ git status` both mean the same command.
		candidate = candidate.replace(/^`+|`+$/g, '').trim();
		candidate = candidate.replace(/^[$%#]\s+/, '').trim();
		if (!candidate) continue;
		return candidate;
	}

	return null;
}
