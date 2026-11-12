/**
 * Constructs the Pianola supervised daemon and its scheduled re-learn job.
 *
 * Only construction and the two pure CLI-mining/rules-read helpers live here
 * - the supervisor/scheduler instances themselves stay as `let`s in
 * main/index.ts because they're read and mutated from several other
 * unscoped locations there (start, stop, the first-party supervisor
 * cross-wire, IPC registration). See CLAUDE.md's decomposition plan for
 * src/main/index.ts (Phase 5 refactoring).
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolveMaestroCliScriptPath } from '../cue/cue-cli-executor';
import { PianolaSupervisor } from './pianola-supervisor';
import { PianolaRelearnScheduler } from './pianola-relearn-scheduler';
import { runRelearnJob } from './pianola-relearn';
import { readRules, writeSuggestions, getProfile } from './pianola-store-main';
import type { DecisionPair } from '../../shared/pianola/transcript-mining';
import type { PianolaRule } from '../../shared/pianola/types';
import type { getSettingsStore, getSessionsStore } from '../stores';

/** Cap on decision pairs the scheduled re-learn pulls from the CLI per run. */
const RELEARN_MAX_PAIRS = 100_000;

/**
 * Mine the installed CLIs' native transcripts into a decision corpus by spawning
 * the existing `pianola learn --json` crawler (the single source of transcript
 * discovery + parsing) and parsing its `pairs`. Rejects on spawn/exit/parse
 * failure so a failed mine leaves the previously staged suggestions untouched.
 */
export function mineDecisionPairsViaCli(): Promise<DecisionPair[]> {
	const cliScriptPath = resolveMaestroCliScriptPath();
	return new Promise<DecisionPair[]>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(
				process.execPath,
				[cliScriptPath, 'pianola', 'learn', '--json', '--max-pairs', String(RELEARN_MAX_PAIRS)],
				{
					env: {
						...process.env,
						// In packaged Electron, process.execPath is the app binary, not
						// Node; without this it would launch the app instead of the CLI.
						ELECTRON_RUN_AS_NODE: '1',
						MAESTRO_CLI_JS: cliScriptPath,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				}
			);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		let stdout = '';
		let stderr = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => {
			stdout += d;
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (d: string) => {
			stderr += d;
		});
		child.on('error', (err) => reject(err));
		child.on('exit', (code) => {
			if (code !== 0) {
				reject(new Error(`pianola learn exited ${code ?? 'null'}: ${stderr.trim().slice(0, 200)}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as { pairs?: unknown };
				resolve(Array.isArray(parsed.pairs) ? (parsed.pairs as DecisionPair[]) : []);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

/**
 * Read the user's live rules and global decision-profile markdown for the
 * re-learn baseline. A missing or malformed profiles file degrades to an empty
 * baseline (getProfile already returns a well-formed empty result), so the job
 * stages a fresh draft rather than crashing.
 */
export function readExistingForRelearn(): { rules: PianolaRule[]; profile: string } {
	return { rules: readRules(), profile: getProfile().entry?.profile ?? '' };
}

export interface PianolaLifecycleDependencies {
	settingsStore: ReturnType<typeof getSettingsStore>;
	sessionsStore: ReturnType<typeof getSessionsStore>;
	logger: { info: (msg: string, tag: string) => void };
}

export interface PianolaLifecycle {
	supervisor: PianolaSupervisor;
	relearnScheduler: PianolaRelearnScheduler;
}

export function createPianolaLifecycle(deps: PianolaLifecycleDependencies): PianolaLifecycle {
	// Initialize the Pianola supervised daemon. It owns Pianola's background
	// watchers and orchestrations as supervised child processes (restart on
	// crash, relaunch on app start, visible health), replacing the unmanaged
	// nohup model. It self-gates on encoreFeatures.pianola and reconciles from a
	// shared store file that both the CLI and renderer write.
	const supervisor = new PianolaSupervisor({
		isEnabled: () => {
			const ef = deps.settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
			return ef.pianola === true;
		},
		getPianolaAgentId: () => {
			const sessions = deps.sessionsStore.get('sessions', []) as Array<{
				id?: string;
				isPianola?: boolean;
			}>;
			return sessions.find((s) => s?.isPianola === true)?.id;
		},
	});

	// Pianola scheduled re-learn: keeps the learned profile fresh as a PROPOSAL
	// (stages suggestions; never overwrites the live profile/rules) and
	// relaunches stale supervised targets, on a fixed cadence. Self-gates per
	// tick on encoreFeatures.pianola. Mining reuses the existing `pianola learn`
	// crawler via the bundled CLI; the composition is pure with injected deps.
	const relearnScheduler = new PianolaRelearnScheduler({
		isEnabled: () => {
			const ef = deps.settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
			return ef.pianola === true;
		},
		runJob: async () => {
			await runRelearnJob({
				isEnabled: () => {
					const ef = deps.settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
					return ef.pianola === true;
				},
				mine: mineDecisionPairsViaCli,
				readExisting: readExistingForRelearn,
				writeSuggestions,
				relaunchStale: () => supervisor?.relaunchStale() ?? 0,
				now: Date.now,
				log: (line) => deps.logger.info(line, '[PianolaRelearn]'),
			});
		},
	});

	return { supervisor, relearnScheduler };
}
