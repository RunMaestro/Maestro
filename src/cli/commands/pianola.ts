/**
 * Pianola CLI commands.
 *
 * `pianola watch <tab-id>` polls a desktop tab's transcript, and when the agent
 * is awaiting the user it classifies the prompt, applies the user's rules, and
 * either auto-answers (low-risk, explicit rule) or records an escalation. Every
 * command hard-gates on the `pianola` Encore flag, so a headless CLI cannot run
 * autonomous behavior on an install that has not opted in.
 *
 * The decision logic lives in the pure, tested watcher (shared/pianola); this
 * file is the I/O shell: WebSocket polling, dispatch, and console output.
 */

import { readSettingValue } from '../services/storage';
import {
	readPianolaRules,
	readPianolaRulesResult,
	appendPianolaDecision,
	readPianolaDecisions,
} from '../services/pianola-store';
import { MaestroClient } from '../services/maestro-client';
import { runDispatch } from './dispatch';
import { generateUUID } from '../../shared/uuid';
import {
	runWatchIteration,
	initialWatchState,
	type WatchDeps,
	type WatchState,
	type WatchTarget,
} from '../../shared/pianola/pianola-watcher';
import type { PianolaMessage } from '../../shared/pianola/types';

const DEFAULT_INTERVAL_SECONDS = 5;
const POLL_TAIL = 40;

export interface PianolaWatchOptions {
	agent?: string;
	interval?: string;
	dryRun?: boolean;
	once?: boolean;
	json?: boolean;
}

export interface PianolaListOptions {
	json?: boolean;
}

export interface PianolaLogOptions {
	limit?: string;
	json?: boolean;
}

interface SessionHistoryResponse {
	success?: boolean;
	error?: string;
	code?: string;
	tabId?: string;
	sessionId?: string;
	agentId?: string;
	agentSessionId?: string | null;
	projectPath?: string;
	messages?: PianolaMessage[];
}

/** Exit with a clear message if the Pianola Encore feature is disabled. */
function ensurePianolaEnabled(json?: boolean): void {
	const flags = readSettingValue('encoreFeatures') as Record<string, unknown> | undefined;
	if (flags?.pianola === true) return;
	const message = 'Pianola is not enabled. Enable it with: maestro-cli encore set pianola on';
	if (json) {
		console.log(JSON.stringify({ success: false, error: message, code: 'PIANOLA_DISABLED' }));
	} else {
		console.error(message);
	}
	process.exit(1);
}

/** Parse `--interval` as seconds ("5" or "5s"); defaults to 5, minimum 1. */
function parseIntervalSeconds(raw?: string): number {
	if (!raw) return DEFAULT_INTERVAL_SECONDS;
	const match = raw.trim().match(/^(\d+)s?$/i);
	if (!match) return DEFAULT_INTERVAL_SECONDS;
	return Math.max(1, parseInt(match[1], 10));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Watch a tab and act on awaiting-input prompts per the configured rules. */
export async function pianolaWatch(tabId: string, options: PianolaWatchOptions): Promise<void> {
	ensurePianolaEnabled(options.json);

	const intervalMs = parseIntervalSeconds(options.interval) * 1000;
	const dryRun = !!options.dryRun;
	const once = !!options.once;

	const deps: WatchDeps = {
		readRules: readPianolaRules,
		dispatch: async (target, answer) => {
			const res = await runDispatch(target.agentId, answer, { tab: target.tabId });
			return { success: !!res.success, error: res.error };
		},
		recordDecision: appendPianolaDecision,
		now: () => new Date().toISOString(),
		genId: () => generateUUID(),
		log: (line) => console.log(line),
	};

	let state: WatchState = initialWatchState();
	let stopped = false;
	const onSignal = (): void => {
		stopped = true;
	};
	process.on('SIGINT', onSignal);

	const client = new MaestroClient();
	try {
		await client.connect();
	} catch (error) {
		process.off('SIGINT', onSignal);
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[pianola] could not connect to Maestro: ${message}`);
		process.exit(1);
		return;
	}

	if (readPianolaRulesResult().malformed) {
		console.error('[pianola] warning: rules file is invalid JSON; no rules will apply until fixed');
	}

	if (!once) {
		console.log(
			`[pianola] watching tab ${tabId} every ${intervalMs / 1000}s${dryRun ? ' (dry-run)' : ''}. Ctrl+C to stop.`
		);
	}

	try {
		for (;;) {
			let resp: SessionHistoryResponse;
			try {
				resp = await client.sendCommand<SessionHistoryResponse>(
					{ type: 'get_session_history', tabId, tail: POLL_TAIL },
					'session_history_result'
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[pianola] poll failed: ${message}`);
				if (once || stopped) break;
				await sleep(intervalMs);
				continue;
			}

			if (!resp.success) {
				console.error(`[pianola] ${resp.error ?? 'session history unavailable'}`);
				if (once || stopped) break;
				await sleep(intervalMs);
				continue;
			}

			const agentId = options.agent ?? resp.agentId ?? '';
			if (!agentId) {
				console.error('[pianola] could not resolve an agent id for this tab; pass --agent');
				break;
			}

			const target: WatchTarget = { tabId, agentId, projectPath: resp.projectPath };
			const messages = resp.messages ?? [];
			try {
				const iteration = await runWatchIteration(messages, target, state, deps, { dryRun });
				state = iteration.state;
			} catch (error) {
				// Unexpected failure (e.g. an audit write failed before dispatch).
				// Fail closed: log and keep watching rather than crashing the loop.
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[pianola] iteration error: ${message}`);
			}

			if (once || stopped) break;
			await sleep(intervalMs);
		}
	} finally {
		process.off('SIGINT', onSignal);
		client.disconnect();
	}
}

/** List the configured Pianola rules (read-only from the CLI). */
export function pianolaRules(options: PianolaListOptions): void {
	ensurePianolaEnabled(options.json);
	const rules = readPianolaRules();
	if (options.json) {
		console.log(JSON.stringify({ rules }));
		return;
	}
	if (rules.length === 0) {
		console.log('No Pianola rules defined.');
		return;
	}
	console.log('Pianola rules:');
	for (const rule of rules) {
		const scope = rule.scope === 'global' ? 'global' : `${rule.scope}:${rule.scopeId ?? '?'}`;
		const label = rule.description ?? rule.id;
		console.log(
			`  ${rule.enabled ? 'on ' : 'off'} [p${rule.priority}] ${scope} ${rule.action} ${label}`
		);
	}
}

/** Show recent decisions from the audit log. */
export function pianolaLog(options: PianolaLogOptions): void {
	ensurePianolaEnabled(options.json);
	const limit = options.limit ? Math.max(1, parseInt(options.limit, 10) || 20) : 20;
	const records = readPianolaDecisions(limit);
	if (options.json) {
		console.log(JSON.stringify({ decisions: records }));
		return;
	}
	if (records.length === 0) {
		console.log('No Pianola decisions recorded yet.');
		return;
	}
	console.log(`Last ${records.length} Pianola decision(s):`);
	for (const rec of records) {
		const flags = [rec.dispatched ? 'sent' : '', rec.dryRun ? 'dry-run' : '']
			.filter(Boolean)
			.join(',');
		const suffix = flags ? ` (${flags})` : '';
		console.log(
			`  ${rec.timestamp} ${rec.classification.kind}/${rec.classification.risk} -> ${rec.decision.action}${suffix} ${rec.classification.topic}`
		);
	}
}
