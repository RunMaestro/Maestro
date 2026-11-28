/**
 * Claude TUI canary: one real maestro-p turn after every Claude Code update.
 *
 * Why it exists
 * -------------
 * Claude agents on the interactive (plan quota) token source run through
 * maestro-p, which drives Claude Code's TUI. The TUI is not an API: each release
 * can add a startup dialog, reword one, or change its default. Claude Code
 * 2.1.326 did, on 2026-11-17: a new "Adding a new directory" prompt that
 * defaults to "No, exit" made every turn of every agent with an extra directory
 * fail, from the moment the update landed (5:00 AM) until someone noticed.
 * Claude Code updates itself while Maestro runs, so no app release can catch it.
 *
 * What it does
 * ------------
 * Hourly, and once shortly after launch, it reads `claude --version`. When the
 * version (or Maestro's own version) differs from the last one checked, it runs
 * one cheap maestro-p turn shaped like a real agent's: the same flags Maestro
 * passes, an `--add-dir` grant, the smallest model, a one-word reply. A failure
 * raises a sticky toast naming the version and what Claude Code showed, so the
 * break is known the morning it lands rather than on the next failed message.
 *
 * It spends a sliver of plan quota per Claude Code release, on an account that
 * already has an authenticated usage snapshot (an account Maestro is known to
 * run TUI turns on). With no such account it does nothing.
 *
 * `maestro-cli claude-canary` reads the last result, and `--run` runs it now.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import Store from 'electron-store';

import type { AgentDetector } from './detector';
import { logger } from '../utils/logger';
import { captureMessage } from '../utils/sentry';
import { getAllSnapshots } from '../stores/claudeUsageStore';
import {
	buildMaestroPProbeEnv,
	ensurePrivateProbeDir,
	ensureUsageProbeDir,
} from './claude-usage-sampler';
import { getMaestroPBinPath } from './claude-usage-startup';
import type {
	ClaudeTuiCanaryResult,
	ClaudeTuiCanaryRunOutcome,
} from '../../shared/claudeTuiCanary';

const execFileAsync = promisify(execFile);
const LOG_CONTEXT = '[ClaudeTuiCanary]';

/** First check after launch: late enough not to compete with startup sampling. */
export const CANARY_FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
/** Version poll cadence. A run only follows a version change. */
export const CANARY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Wall clock for the whole canary turn, startup dialogs included. */
const CANARY_TURN_TIMEOUT_MS = 3 * 60 * 1000;
const VERSION_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Second folder the canary grants with `--add-dir`, never trusted on its own. */
const CANARY_EXTRA_DIR_NAME = 'maestro-claude-canary-extra';

// Same flags Maestro passes when it spawns a TUI-mode Claude agent, plus an
// extra-directory grant: the shape that broke on 2026-11-17.
const CANARY_PROMPT = 'Reply with exactly the word ok and nothing else.';
const CANARY_MODEL = 'haiku';

interface CanaryStoreData {
	last?: ClaudeTuiCanaryResult;
}

let store: Store<CanaryStoreData> | null = null;
function getStore(): Store<CanaryStoreData> {
	if (store === null) store = new Store<CanaryStoreData>({ name: 'claude-tui-canary' });
	return store;
}

/** The `x.y.z` in `claude --version` output ("2.1.326 (Claude Code)"). */
export function parseClaudeVersion(output: string): string | null {
	const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output);
	return match ? match[1] : null;
}

/** Whether a check is due: never checked, or Claude Code or Maestro changed since. */
export function isCanaryDue(
	last: ClaudeTuiCanaryResult | undefined,
	claudeVersion: string,
	maestroVersion: string
): boolean {
	if (!last) return true;
	return last.claudeVersion !== claudeVersion || last.maestroVersion !== maestroVersion;
}

/**
 * What a canary turn's stdout says: the maestro-p result envelope's verdict,
 * its error code, and the screen it attached. A run with no envelope failed
 * before maestro-p could report (a crash, a kill at the timeout).
 */
export function interpretCanaryOutput(
	stdout: string,
	exitCode: number | null
): Pick<ClaudeTuiCanaryResult, 'ok' | 'error' | 'screen' | 'exitCode'> {
	let envelope: Record<string, unknown> | null = null;
	for (const line of stdout.split('\n').reverse()) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (parsed?.type === 'result') {
				envelope = parsed;
				break;
			}
		} catch {
			// Not JSON: keep looking further up.
		}
	}
	if (!envelope) {
		return { ok: false, error: 'no_result', exitCode };
	}
	const failed = envelope.is_error === true || (exitCode !== null && exitCode !== 0);
	const screen = typeof envelope.last_screen === 'string' ? envelope.last_screen : undefined;
	if (!failed) return { ok: true, exitCode };
	return {
		ok: false,
		error: typeof envelope.error === 'string' ? envelope.error : 'failed',
		exitCode,
		...(screen ? { screen } : {}),
	};
}

/**
 * The account to run on: the most recently sampled authenticated plan account.
 * An account with a fresh, authenticated `/usage` snapshot is one maestro-p has
 * just driven successfully, so the turn will not stall on a login.
 */
function pickCanaryAccount(): string | null {
	let best: { key: string; at: number } | null = null;
	for (const [key, snapshot] of Object.entries(getAllSnapshots())) {
		if (snapshot.authState === 'unauthenticated') continue;
		const at = Date.parse(snapshot.sampledAt);
		if (!Number.isFinite(at)) continue;
		if (!best || at > best.at) best = { key, at };
	}
	return best?.key ?? null;
}

async function readClaudeVersion(claudeBin: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(claudeBin, ['--version'], {
			encoding: 'utf8',
			timeout: VERSION_TIMEOUT_MS,
		});
		return parseClaudeVersion(stdout);
	} catch {
		return null;
	}
}

export interface ClaudeTuiCanaryDeps {
	agentDetector: Pick<AgentDetector, 'getAgent'>;
	/** Maestro's own version (`app.getVersion()`). */
	maestroVersion: string;
	/** Raise a toast in every window (the `remote:notifyToast` channel). */
	notifyToast: (toast: {
		title: string;
		message: string;
		color: 'red' | 'green';
		dismissible: boolean;
	}) => void;
	now?: () => number;
}

export class ClaudeTuiCanary {
	private readonly deps: ClaudeTuiCanaryDeps;
	private firstTimer: ReturnType<typeof setTimeout> | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private running: Promise<ClaudeTuiCanaryRunOutcome> | null = null;

	constructor(deps: ClaudeTuiCanaryDeps) {
		this.deps = deps;
	}

	/** Arm the first check and the hourly poll. Idempotent. */
	start(): void {
		if (this.interval) return;
		this.firstTimer = setTimeout(() => void this.check(), CANARY_FIRST_CHECK_DELAY_MS);
		this.interval = setInterval(() => void this.check(), CANARY_CHECK_INTERVAL_MS);
	}

	stop(): void {
		if (this.firstTimer) clearTimeout(this.firstTimer);
		if (this.interval) clearInterval(this.interval);
		this.firstTimer = null;
		this.interval = null;
	}

	/** The last finished run, or undefined when none has run. */
	getLastResult(): ClaudeTuiCanaryResult | undefined {
		return getStore().get('last');
	}

	/**
	 * Run the canary when it is due, or always with `force`. Concurrent calls
	 * share one run. Never throws: an outcome that could not run says why.
	 */
	check(options: { force?: boolean } = {}): Promise<ClaudeTuiCanaryRunOutcome> {
		if (this.running) return this.running;
		this.running = this.checkNow(options.force === true).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async checkNow(force: boolean): Promise<ClaudeTuiCanaryRunOutcome> {
		const claude = await this.deps.agentDetector.getAgent('claude-code');
		if (!claude?.available) return { ran: false, reason: 'Claude Code is not installed.' };
		const claudeBin = claude.path || claude.command;
		const claudeVersion = await readClaudeVersion(claudeBin);
		if (!claudeVersion) {
			return { ran: false, reason: `Could not read the version of ${claudeBin}.` };
		}
		const last = this.getLastResult();
		if (!force && !isCanaryDue(last, claudeVersion, this.deps.maestroVersion)) {
			return { ran: false, reason: `Claude Code ${claudeVersion} was already checked.`, last };
		}
		const maestroPBin = getMaestroPBinPath();
		if (!maestroPBin) return { ran: false, reason: 'The bundled maestro-p was not found.' };
		const configDir = pickCanaryAccount();
		if (!configDir) {
			return {
				ran: false,
				reason:
					'No Claude account has an authenticated usage snapshot yet, so there is no account known to run TUI turns.',
			};
		}
		const cwd = await ensureUsageProbeDir();
		const extraDir = await ensurePrivateProbeDir(CANARY_EXTRA_DIR_NAME);
		if (!cwd || !extraDir) {
			return { ran: false, reason: 'The private probe folders could not be created.' };
		}

		logger.info(`Running the TUI canary on Claude Code ${claudeVersion}`, LOG_CONTEXT, {
			configDir,
		});
		const startedAt = (this.deps.now ?? Date.now)();
		const env = buildMaestroPProbeEnv({ MAESTRO_CLAUDE_BIN: claudeBin }, configDir);
		const args = [
			maestroPBin,
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
			'--add-dir',
			extraDir,
			'--model',
			CANARY_MODEL,
			'-p',
			CANARY_PROMPT,
		];
		let stdout = '';
		let exitCode: number | null = 0;
		try {
			({ stdout } = await execFileAsync(process.execPath, args, {
				cwd,
				env,
				encoding: 'utf8',
				maxBuffer: MAX_BUFFER_BYTES,
				timeout: CANARY_TURN_TIMEOUT_MS,
			}));
		} catch (err) {
			const failure = err as { stdout?: string; code?: unknown };
			stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
			exitCode = typeof failure.code === 'number' ? failure.code : null;
		}

		const result: ClaudeTuiCanaryResult = {
			claudeVersion,
			maestroVersion: this.deps.maestroVersion,
			checkedAt: (this.deps.now ?? Date.now)(),
			durationMs: (this.deps.now ?? Date.now)() - startedAt,
			configDir,
			...interpretCanaryOutput(stdout, exitCode),
		};
		const previous = last;
		getStore().set('last', result);
		this.report(result, previous);
		return { ran: true, result };
	}

	private report(result: ClaudeTuiCanaryResult, previous: ClaudeTuiCanaryResult | undefined): void {
		if (result.ok) {
			logger.info(`TUI canary passed on Claude Code ${result.claudeVersion}`, LOG_CONTEXT);
			if (previous && !previous.ok) {
				this.deps.notifyToast({
					title: `Claude Code ${result.claudeVersion} works in TUI mode again`,
					message: 'The Claude TUI canary passed.',
					color: 'green',
					dismissible: false,
				});
			}
			return;
		}
		logger.warn(`TUI canary failed on Claude Code ${result.claudeVersion}`, LOG_CONTEXT, {
			error: result.error,
			exitCode: result.exitCode,
		});
		// Field signal for maintainers: which release broke which failure code.
		// The screen stays local; it can show account details.
		void captureMessage('Claude TUI canary failed', 'warning', {
			claudeVersion: result.claudeVersion,
			maestroVersion: result.maestroVersion,
			error: result.error,
			exitCode: result.exitCode,
		});
		this.deps.notifyToast({
			title: `Claude Code ${result.claudeVersion} may break TUI-mode agents`,
			message: `A test turn through maestro-p failed (${result.error}). Run \`maestro-cli claude-canary\` for what Claude Code showed. Agents on the claude -p token source are not affected.`,
			color: 'red',
			dismissible: true,
		});
	}
}

let instance: ClaudeTuiCanary | null = null;

/** Register the app's canary, for the CLI handlers. */
export function setClaudeTuiCanary(canary: ClaudeTuiCanary | null): void {
	instance = canary;
}

export function getClaudeTuiCanary(): ClaudeTuiCanary | null {
	return instance;
}
