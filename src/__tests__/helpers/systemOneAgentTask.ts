/**
 * The System One agent task: one job a real agent is handed to find out whether
 * being TOLD about System One (the L0 section of the Maestro system prompt)
 * makes it use System One, and use it well.
 *
 * The job, in a scratch directory:
 *   "Here are 40 one-line commit messages in `commits.txt`. Which ones describe
 *    a security fix? Write the line numbers to `security.txt`."
 *
 * It suits System One by shape (one judgment repeated over a list) and it has a
 * known answer, so a run can be scored. Whether it suits by SIZE is the open
 * question, so the list can be built longer (`securityTaskCommits(400)`) with
 * the labels still known. This module holds the list and its labels, and the
 * rules that read what a run did: which `maestro-cli s1` verbs
 * it ran and in what order, whether it keyed the items or asked about positions
 * in a list, and how its answer compares with the labels.
 *
 * Pure: no process, no network, no file. The opt-in suite that runs the job
 * (`system-one/agent-use-e2e.test.ts`) and this module's own unit test use it.
 */

import { jsonLines } from './streamJson';

export interface SecurityTaskCommit {
	message: string;
	/** Whether the message describes a security fix. */
	security: boolean;
}

/**
 * The base list. 12 of the 40 (30%) are security fixes. The rest are split between
 * plain work and messages that use a security word without fixing anything (a
 * typo in SECURITY.md, a rename of an auth class, a faster password meter), so
 * sorting by vocabulary gets it wrong.
 */
const BASE_COMMITS: readonly SecurityTaskCommit[] = Object.freeze([
	{ message: 'Add CSV export to the reports page', security: false },
	{
		message: 'Escape user-supplied HTML in the comment preview to stop stored XSS',
		security: true,
	},
	{ message: 'Fix typo in the SECURITY.md contact address', security: false },
	{ message: 'Fix crash when an avatar upload is cancelled', security: false },
	{
		message: 'Use parameterized queries in the order search endpoint (SQL injection)',
		security: true,
	},
	{ message: 'Rename AuthService to SessionService', security: false },
	{ message: 'Upgrade React from 18.2 to 18.3', security: false },
	{ message: 'Cache the dashboard query for 60 seconds', security: false },
	{
		message: 'Bump lodash from 4.17.15 to 4.17.21 for the prototype pollution fix (CVE-2020-8203)',
		security: true,
	},
	{ message: 'Add dark mode to the login page', security: false },
	{ message: 'Remove the dead feature flag for the old onboarding', security: false },
	{
		message: 'Validate redirect_uri against the allowlist in the OAuth callback',
		security: true,
	},
	{ message: 'Fix timezone offset in the weekly digest email', security: false },
	{ message: 'Speed up rendering of the password strength meter', security: false },
	{ message: 'Stop logging the full Authorization header in request traces', security: true },
	{ message: 'Add retry with backoff to the S3 uploader', security: false },
	{ message: 'Fix flaky test in the token refresh suite', security: false },
	{ message: 'Document the release checklist', security: false },
	{ message: 'Compare webhook signatures in constant time', security: true },
	{ message: 'Fix layout shift on the pricing table', security: false },
	{ message: 'Update the copy on the two-factor setup screen', security: false },
	{
		message: 'Reject archive entries with ../ in their path during plugin install',
		security: true,
	},
	{ message: 'Add German translation for the settings pages', security: false },
	{ message: 'Move the firewall rule docs to the ops handbook', security: false },
	{ message: 'Fix memory leak in the websocket reconnect loop', security: false },
	{ message: 'Rotate the session id on login to prevent session fixation', security: true },
	{ message: 'Bump eslint from 8.56 to 8.57', security: false },
	{ message: 'Sort team members alphabetically in the sidebar', security: false },
	{ message: 'Add a CSRF token check to the account email change form', security: true },
	{ message: 'Add an index on users.email to speed up the login lookup', security: false },
	{ message: 'Increase the test timeout for the CI smoke job', security: false },
	{ message: 'Fix IDOR: check invoice ownership before serving the PDF', security: true },
	{ message: 'Fix wrong currency symbol on the invoice PDF', security: false },
	{ message: 'Refactor the permissions table into a hook', security: false },
	{ message: 'Disable external entity expansion in the XML importer (XXE)', security: true },
	{ message: 'Add a keyboard shortcut for quick search', security: false },
	{ message: 'Rename a variable in the encryption benchmark script', security: false },
	{ message: 'Hash password reset tokens before storing them', security: true },
	{ message: 'Clean up unused CSS in the admin panel', security: false },
	{ message: 'Fix off-by-one in pagination of the audit log', security: false },
]);

export const SECURITY_TASK_INPUT_FILE = 'commits.txt';
export const SECURITY_TASK_ANSWER_FILE = 'security.txt';

/** The size of the job as the playbook states it. */
export const SECURITY_TASK_DEFAULT_ITEMS = BASE_COMMITS.length;

/**
 * Areas of a codebase, for a longer list: each base message once per area, as
 * `area: message`. `auth` and `crypto` are in it on purpose: an area is where
 * the change was made, not what it fixed.
 */
const SCOPES = [
	'billing',
	'api',
	'web',
	'mobile',
	'admin',
	'search',
	'auth',
	'crypto',
	'infra',
	'sync',
] as const;

/** A fixed pseudo-random sequence (mulberry32), so a longer list is the same list on every run. */
function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The list for a job of `items` lines. The default is the base list in its own
 * order. A longer one (a multiple of the base, up to one per area) is every
 * base message under each of the first `items / 40` areas, shuffled by a fixed
 * seed so no pattern repeats every 40 lines. 30% are security fixes at every
 * size.
 */
export function securityTaskCommits(items = SECURITY_TASK_DEFAULT_ITEMS): SecurityTaskCommit[] {
	const copies = items / BASE_COMMITS.length;
	if (!Number.isInteger(copies) || copies < 1 || copies > SCOPES.length) {
		throw new Error(
			`The list is ${BASE_COMMITS.length} items or a multiple of it up to ${BASE_COMMITS.length * SCOPES.length}, not ${items}.`
		);
	}
	if (copies === 1) return BASE_COMMITS.map((commit) => ({ ...commit }));
	const commits = SCOPES.slice(0, copies).flatMap((scope) =>
		BASE_COMMITS.map((commit) => ({ ...commit, message: `${scope}: ${commit.message}` }))
	);
	const random = seededRandom(items);
	for (let i = commits.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[commits[i], commits[j]] = [commits[j], commits[i]];
	}
	return commits;
}

/** The job, word for word as an agent gets it. It names no tool. */
export function securityTaskPrompt(items = SECURITY_TASK_DEFAULT_ITEMS): string {
	return `Here are ${items} one-line commit messages in \`${SECURITY_TASK_INPUT_FILE}\`. Which ones describe a security fix? Write the line numbers to \`${SECURITY_TASK_ANSWER_FILE}\`.`;
}

/** `commits.txt`: one message a line, so a line number is a key. */
export function securityTaskInput(commits: readonly SecurityTaskCommit[]): string {
	return `${commits.map((commit) => commit.message).join('\n')}\n`;
}

/** The line numbers (from 1) of the security fixes. */
export function securityTaskLabels(commits: readonly SecurityTaskCommit[]): number[] {
	return commits.flatMap((commit, index) => (commit.security ? [index + 1] : []));
}

/**
 * The line numbers an agent wrote to `security.txt`. The job does not say how
 * to write them, so both common shapes are read: a line that holds only
 * numbers and separators gives every number on it, and a line with words (a
 * number and its commit message) gives its first number, because a number
 * later on the line belongs to the message. Numbers outside the list are
 * dropped; the result is sorted with no repeats.
 */
export function readSecurityAnswer(text: string, items = SECURITY_TASK_DEFAULT_ITEMS): number[] {
	const found = new Set<number>();
	for (const line of text.split('\n')) {
		const numbers = line.match(/\d+/g);
		if (!numbers) continue;
		const onlyNumbers = /^[\s\d,;.\-[\]()]+$/.test(line);
		for (const raw of onlyNumbers ? numbers : numbers.slice(0, 1)) {
			const value = Number(raw);
			if (value >= 1 && value <= items) found.add(value);
		}
	}
	return [...found].sort((a, b) => a - b);
}

export interface SecurityTaskScore {
	answered: number[];
	truePositives: number;
	/** Line numbers the agent listed that are not security fixes. */
	falsePositives: number[];
	/** Security fixes the agent left out. */
	falseNegatives: number[];
	/** Of the lines listed, the share that are security fixes. 1 when none was listed. */
	precision: number;
	/** Of the security fixes, the share listed. */
	recall: number;
	f1: number;
	/** Of all the lines, the share sorted correctly. */
	accuracy: number;
	exact: boolean;
}

/** Compare an answer with the labels of the list it was given. */
export function scoreSecurityAnswer(
	answered: number[],
	commits: readonly SecurityTaskCommit[]
): SecurityTaskScore {
	const labels = new Set(securityTaskLabels(commits));
	const listed = new Set(answered);
	const falsePositives = answered.filter((line) => !labels.has(line));
	const falseNegatives = [...labels].filter((line) => !listed.has(line));
	const truePositives = answered.length - falsePositives.length;
	const precision = answered.length === 0 ? 1 : truePositives / answered.length;
	const recall = truePositives / labels.size;
	const wrong = falsePositives.length + falseNegatives.length;
	return {
		answered,
		truePositives,
		falsePositives,
		falseNegatives,
		precision,
		recall,
		f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
		accuracy: (commits.length - wrong) / commits.length,
		exact: wrong === 0,
	};
}

// ---------------------------------------------------------------------------
// What a run did
// ---------------------------------------------------------------------------

/** The `s1` verbs that send a question to an engine. */
export const SYSTEM_ONE_ASKING_VERBS = ['yes', 'pick', 'rate', 'ask', 'rank', 'batch'] as const;
/** The asking verbs that take the list and key every item themselves. */
const KEYING_VERBS: readonly string[] = ['rank', 'batch'];
const OTHER_VERBS = ['guide', 'examples', 'usage', 'cost', 'status', 'ledger', 'set', 'test'];

const S1_INVOCATION = new RegExp(
	`\\bs1\\s+(${[...SYSTEM_ONE_ASKING_VERBS, ...OTHER_VERBS].join('|')})\\b`,
	'gi'
);

/** A question about a place in a list: "line 7", "item #3", "commit 12". */
const POSITION_REFERENCE = /\b(?:lines?|items?|entr(?:y|ies)|commits?|messages?|rows?)\s*#?\d+\b/i;

/** The whole list handed to one question as its state, by flag or through a pipe. */
function handsWholeList(command: string): boolean {
	const file = SECURITY_TASK_INPUT_FILE.replace('.', '\\.');
	return (
		new RegExp(`(?:-s|--state)[\\s=]+["']?@[^\\s"']*${file}`).test(command) ||
		new RegExp(`--state-file[\\s=]+["']?[^\\s"']*${file}`).test(command) ||
		new RegExp(
			`\\bcat\\s+["']?[^\\s"'|]*${file}["']?\\s*\\|[^|]*\\bs1\\s+(?:yes|pick|rate|ask)\\b`,
			'i'
		).test(command)
	);
}

/**
 * A shell command that prints the WHOLE list, so every item lands in the
 * agent's context. `head -5` and `wc -l` size the job and are not this.
 */
const PRINTS_LIST = new RegExp(
	`(?:^|[\\s;&|(])(?:cat|nl|less|more|bat)\\s[^|;&\\n]*${SECURITY_TASK_INPUT_FILE.replace('.', '\\.')}`
);

/**
 * How the items reached the engine:
 * - `none`: no question was asked.
 * - `keyed`: only `rank` or `batch`, which key every item by its line.
 * - `per-item`: `yes`, `pick`, `rate` or `ask` with one item to a request.
 * - `indexed`: a question about a place in the list ("is line 7 a security
 *   fix?"), or the whole list as the state of one question. This is the use
 *   the guide measures as wrong 27% of the time at 150 items.
 *
 * Read from the command text, so it is a rule of thumb: the commands are kept
 * beside it for a person to check.
 */
export type SystemOneKeying = 'none' | 'keyed' | 'per-item' | 'indexed';

export interface SystemOneInvocation {
	verb: string;
	/** The shell command it was part of, whole. */
	command: string;
}

export interface SystemOneAgentUse {
	/** Every tool call the agent made. */
	toolCalls: number;
	/** Every shell command, in order. */
	commands: string[];
	/** Every `s1 <verb>` in those commands, in order. One command can hold several. */
	invocations: SystemOneInvocation[];
	/** How many times each verb appears in a command. A loop counts once. */
	verbs: Record<string, number>;
	ranGuide: boolean;
	/** Whether `s1 guide` came before the first question. Null when no question was asked. */
	guideBeforeFirstAsk: boolean | null;
	keying: SystemOneKeying;
	/** Whether the agent read the whole list into its own context (the Read tool, or a command that prints it all). */
	readList: boolean;
	/** Whether a command ran the standalone `jev` CLI. */
	usedJevCli: boolean;
}

function isAsking(verb: string): boolean {
	return (SYSTEM_ONE_ASKING_VERBS as readonly string[]).includes(verb);
}

/** What a run did with System One, from Claude Code's `stream-json` output. */
export function readSystemOneUse(stdout: string): SystemOneAgentUse {
	const commands: string[] = [];
	let toolCalls = 0;
	let readList = false;
	for (const event of jsonLines(stdout)) {
		if (event.type !== 'assistant') continue;
		const content = (event.message as { content?: unknown } | undefined)?.content;
		for (const block of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
			if (block.type !== 'tool_use') continue;
			toolCalls++;
			const input = (block.input ?? {}) as { command?: unknown; file_path?: unknown };
			if (typeof input.command === 'string') commands.push(input.command);
			if (
				block.name === 'Read' &&
				typeof input.file_path === 'string' &&
				input.file_path.endsWith(SECURITY_TASK_INPUT_FILE)
			) {
				readList = true;
			}
		}
	}

	const invocations: SystemOneInvocation[] = [];
	for (const command of commands) {
		for (const match of command.matchAll(S1_INVOCATION)) {
			invocations.push({ verb: match[1].toLowerCase(), command });
		}
		if (PRINTS_LIST.test(command) && !handsWholeList(command)) readList = true;
	}

	const verbs: Record<string, number> = {};
	for (const { verb } of invocations) verbs[verb] = (verbs[verb] ?? 0) + 1;

	const asking = invocations.filter(({ verb }) => isAsking(verb));
	const firstAsk = invocations.findIndex(({ verb }) => isAsking(verb));
	const firstGuide = invocations.findIndex(({ verb }) => verb === 'guide');

	let keying: SystemOneKeying = 'none';
	if (asking.length > 0) {
		const single = asking.filter(({ verb }) => !KEYING_VERBS.includes(verb));
		if (single.length === 0) keying = 'keyed';
		else if (
			single.some(({ command }) => POSITION_REFERENCE.test(command) || handsWholeList(command))
		) {
			keying = 'indexed';
		} else keying = 'per-item';
	}

	return {
		toolCalls,
		commands,
		invocations,
		verbs,
		ranGuide: firstGuide !== -1,
		guideBeforeFirstAsk: firstAsk === -1 ? null : firstGuide !== -1 && firstGuide < firstAsk,
		keying,
		readList,
		usedJevCli: commands.some((command) => /(?:^|[\s;&|(])jev\s+\w/.test(command)),
	};
}

export interface ClaudeRunSummary {
	/** The model the harness says it ran, from its first line. */
	model: string;
	/** The skills and MCP servers the harness loaded: what else the agent could reach for. */
	skills: string[];
	mcpServers: string[];
	/** Model turns, by the harness's own count. */
	turns: number;
	/** What the turn cost at the provider's list price, by the harness's own sum. */
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** The harness's last words. */
	finalMessage: string;
	/** Set when the stream has no result, or the result is an error. */
	error?: string;
}

function names(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) =>
		typeof entry === 'string' ? entry : String((entry as { name?: unknown })?.name ?? '')
	);
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The harness's own account of a run: its first line (`system`, `init`) and its last (`result`). */
export function readClaudeRun(stdout: string): ClaudeRunSummary {
	const summary: ClaudeRunSummary = {
		model: '',
		skills: [],
		mcpServers: [],
		turns: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		finalMessage: '',
	};
	let sawResult = false;
	for (const event of jsonLines(stdout)) {
		if (event.type === 'system' && event.subtype === 'init') {
			summary.model = typeof event.model === 'string' ? event.model : '';
			summary.skills = names(event.skills);
			summary.mcpServers = names(event.mcp_servers);
		} else if (event.type === 'result') {
			sawResult = true;
			const usage = (event.usage ?? {}) as Record<string, unknown>;
			summary.turns = count(event.num_turns);
			summary.costUsd = count(event.total_cost_usd);
			summary.inputTokens = count(usage.input_tokens);
			summary.outputTokens = count(usage.output_tokens);
			summary.cacheReadTokens = count(usage.cache_read_input_tokens);
			summary.cacheWriteTokens = count(usage.cache_creation_input_tokens);
			summary.finalMessage = typeof event.result === 'string' ? event.result.trim() : '';
			if (event.is_error === true || event.subtype !== 'success') {
				summary.error = (summary.finalMessage || String(event.subtype)).slice(0, 300);
			}
		}
	}
	if (!sawResult) summary.error = 'The stream ended without a result.';
	return summary;
}
