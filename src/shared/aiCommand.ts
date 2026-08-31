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

/**
 * How many previously-run commands the prompt carries.
 *
 * A follow-up ("actually just the count") almost always refines the command
 * immediately above it, so the first entry does nearly all the work. The rest
 * are there for the case where the user ran something unrelated in between, and
 * the tail is cheap. Far more than this and the history starts to outweigh the
 * request itself, which makes the model refine an old command instead of
 * answering the new question.
 */
export const AI_COMMAND_HISTORY_LIMIT = 8;

/** Longest command line carried into the history block, before ellipsis. */
const MAX_HISTORY_COMMAND_LENGTH = 400;

/**
 * Longest request carried into the history block. Shorter than the command
 * cap: the command has to stay runnable-looking to be refined, while a request
 * only has to convey intent, and the first sentence carries nearly all of it.
 */
const MAX_HISTORY_REQUEST_LENGTH = 200;

/**
 * Flatten to one line and cap the length.
 *
 * The newline collapse is not cosmetic. The history block is a list where one
 * entry is one or two labeled lines, and a request is typed into a MULTILINE
 * composer - so a request containing a newline would otherwise inject what
 * looks like a new list item, letting the user's own text forge entries in the
 * block above their request.
 */
function flattenForHistory(value: string, maxLength: number): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > maxLength ? `${flat.slice(0, maxLength)}...` : flat;
}

/** One previously-run command, as the prompt sees it. */
export interface AiCommandHistoryEntry {
	/** The command line that ran. */
	command: string;
	/**
	 * The plain-English request it was generated from, when it came from AI
	 * command mode. Absent for a command the user typed.
	 *
	 * Carried because a follow-up refines the REQUEST as much as the command:
	 * "actually just the count" against `find . -newermt '2 days ago' -type f`
	 * is far easier to honour when the model can also see that the line was
	 * asked for as "files edited in the past two days". Without it, the model
	 * has to reverse-engineer the intent from flags.
	 */
	request?: string;
	/** Its exit code, when it finished. */
	exitCode?: number;
	/** Whether it finished, was stopped, or is still going. */
	status?: 'running' | 'finished' | 'cancelled';
}

/** The minimum a transcript entry must look like to be mined for history. */
export interface CommandCardLike {
	shellCommand?: {
		command: string;
		request?: string;
		exitCode?: number;
		status?: 'running' | 'finished' | 'cancelled';
	};
}

/**
 * Pull the most recent commands out of a tab's transcript, newest last.
 *
 * Reads the transcript rather than `aiCommandHistory` on purpose. That list is
 * per AGENT, deduplicated, and order-normalized (a repeat moves to the end), so
 * it cannot answer "what did I just run in THIS tab" - which is the only
 * question a follow-up is asking. The transcript is per tab and in true
 * chronological order.
 *
 * Consecutive repeats collapse: re-running the same command to watch it change
 * is common, and eight copies of one line crowds out the context that matters.
 */
export function collectRecentCommands(
	logs: readonly CommandCardLike[],
	limit: number = AI_COMMAND_HISTORY_LIMIT
): AiCommandHistoryEntry[] {
	if (limit <= 0) return [];

	const entries: AiCommandHistoryEntry[] = [];
	// Walk backwards so the cap keeps the NEWEST commands, then restore order.
	for (let i = logs.length - 1; i >= 0 && entries.length < limit; i--) {
		const shell = logs[i]?.shellCommand;
		if (!shell?.command) continue;
		if (entries[entries.length - 1]?.command === shell.command) continue;
		entries.push({
			command: shell.command,
			...(shell.request && { request: shell.request }),
			...(shell.exitCode !== undefined && { exitCode: shell.exitCode }),
			...(shell.status && { status: shell.status }),
		});
	}
	return entries.reverse();
}

/**
 * Render the history block, or an empty string when there is nothing to show.
 *
 * Failures are labeled rather than filtered out. "That didn't work, try
 * something else" is a common follow-up, and a model that cannot see the
 * failure just proposes the same broken command again.
 */
export function formatRecentCommands(entries: readonly AiCommandHistoryEntry[]): string {
	if (entries.length === 0) return '';

	const lines = entries.flatMap((entry) => {
		const command = flattenForHistory(entry.command, MAX_HISTORY_COMMAND_LENGTH);

		const note =
			entry.status === 'running'
				? ' (still running)'
				: entry.status === 'cancelled'
					? ' (stopped by the user)'
					: entry.exitCode !== undefined && entry.exitCode !== 0
						? ` (failed, exit ${entry.exitCode})`
						: '';

		// The request goes ABOVE its command, so the pair reads in the order it
		// happened: the user asked, then this ran.
		return entry.request
			? [
					`- Asked: ${flattenForHistory(entry.request, MAX_HISTORY_REQUEST_LENGTH)}`,
					`  Ran: ${command}${note}`,
				]
			: [`- Ran: ${command}${note}`];
	});

	return [
		'## Recent commands',
		'',
		'Commands already run in this conversation, oldest first. The LAST one is the most recent, and is what a follow-up request almost always refers to.',
		'',
		'"Asked" is the plain-English request a command was generated from - use it to understand what the command was FOR, since the command line alone rarely says. An entry with no "Asked" line was typed directly by the user.',
		'',
		...lines,
	].join('\n');
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
 * Substitution is a plain token swap rather than the template-variable engine
 * because this prompt is never user-authored with arbitrary variables - it has
 * a fixed, documented set.
 *
 * It runs in ONE pass, so substituted text is never rescanned for further
 * tokens. That matters because two of the values are attacker-adjacent: the
 * request is whatever the user typed, and the history is command lines they
 * previously ran. Chained `.replace()` calls would let a command like
 * `echo {{USER_REQUEST}}` sitting in the history get filled in by the next
 * replace in the chain, silently rewriting the prompt from inside its own data.
 * A single pass makes every value inert by construction, with no ordering rule
 * for a future edit to get wrong.
 */
export function buildAiCommandPrompt(
	template: string,
	host: AiCommandHost,
	request: string,
	recentCommands: readonly AiCommandHistoryEntry[] = []
): string {
	const values: Record<string, string> = {
		OS: describePlatform(host.platform, host.release),
		SHELL: host.shell || 'unknown',
		CWD: host.cwd,
		IS_GIT_REPO: host.isGitRepo ? 'yes' : 'no',
		REMOTE_LINE: host.remoteName
			? `- Remote: this command runs on the SSH remote "${host.remoteName}", not on the local machine`
			: '',
		RECENT_COMMANDS: formatRecentCommands(recentCommands),
		USER_REQUEST: request,
	};

	// An unknown token is left verbatim rather than blanked: a typo in an edited
	// prompt should be visible, not silently swallowed.
	return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, token: string) =>
		token in values ? values[token] : match
	);
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
