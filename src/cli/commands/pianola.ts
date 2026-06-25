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
	writePianolaRules,
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
import { matchHasNarrowingPredicate } from '../../shared/pianola/pianola-policy';
import type {
	PianolaMessage,
	PianolaRule,
	PianolaRuleScope,
	PianolaActionKind,
	PianolaRisk,
	PianolaSignalKind,
} from '../../shared/pianola/types';

const RULE_SCOPES: PianolaRuleScope[] = ['global', 'project', 'tab'];
const RULE_ACTIONS: PianolaActionKind[] = ['auto_answer', 'escalate', 'ignore'];
const RULE_RISKS: PianolaRisk[] = ['low', 'medium', 'high'];
const RULE_KINDS: PianolaSignalKind[] = ['question', 'blocked', 'none'];

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

export interface PianolaAddRuleOptions {
	scope?: string;
	scopeId?: string;
	action?: string;
	answer?: string;
	maxRisk?: string;
	kinds?: string;
	topicIncludes?: string;
	priority?: string;
	description?: string;
	disabled?: boolean;
	json?: boolean;
}

/** Split a comma-separated flag value into trimmed, non-empty items. */
function parseCsv(raw?: string): string[] | undefined {
	if (!raw) return undefined;
	const items = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/**
 * Add a Pianola rule from the CLI. This is how the Pianola manager agent turns a
 * conversation with the user ("always let agents run the test suite") into a
 * durable rule the watcher applies. Validates the assembled rule the same way
 * the desktop editor does (auto_answer needs both a narrowing predicate and an
 * answer) so a rule that could never safely fire is rejected with a clear error
 * rather than silently written.
 */
export function pianolaAddRule(options: PianolaAddRuleOptions): void {
	ensurePianolaEnabled(options.json);

	const fail = (message: string): never => {
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: message }));
		} else {
			console.error(message);
		}
		process.exit(1);
	};

	const scope = (options.scope ?? 'global') as PianolaRuleScope;
	if (!RULE_SCOPES.includes(scope)) {
		fail(`--scope must be one of: ${RULE_SCOPES.join(', ')}`);
	}
	if (scope !== 'global' && !options.scopeId) {
		fail(
			`--scope ${scope} requires --scope-id (the ${scope === 'project' ? 'project path' : 'tab id'})`
		);
	}

	const action = options.action as PianolaActionKind | undefined;
	if (!action || !RULE_ACTIONS.includes(action)) {
		fail(`--action is required and must be one of: ${RULE_ACTIONS.join(', ')}`);
	}
	// fail() exits the process, but its return type does not narrow `action` here,
	// so pin the validated value explicitly for the rest of the function.
	const resolvedAction: PianolaActionKind = action as PianolaActionKind;

	const maxRisk = options.maxRisk as PianolaRisk | undefined;
	if (maxRisk && !RULE_RISKS.includes(maxRisk)) {
		fail(`--max-risk must be one of: ${RULE_RISKS.join(', ')}`);
	}

	const kinds = parseCsv(options.kinds) as PianolaSignalKind[] | undefined;
	if (kinds) {
		const bad = kinds.filter((k) => !RULE_KINDS.includes(k));
		if (bad.length > 0) {
			fail(`--kinds has invalid value(s): ${bad.join(', ')}. Valid: ${RULE_KINDS.join(', ')}`);
		}
	}

	const topicIncludes = parseCsv(options.topicIncludes);

	const match: PianolaRule['match'] = {};
	if (maxRisk) match.maxRisk = maxRisk;
	if (kinds) match.kinds = kinds;
	if (topicIncludes) match.topicIncludes = topicIncludes;

	// An auto_answer rule that matches everything is dangerous: it would let the
	// watcher reply to prompts the user never anticipated. Require both a
	// narrowing predicate and an answer, matching the desktop RuleEditor.
	if (resolvedAction === 'auto_answer') {
		if (!matchHasNarrowingPredicate(match)) {
			fail(
				'auto_answer rules need a narrowing predicate: set at least one of --max-risk, --kinds, --topic-includes'
			);
		}
		if (!options.answer || options.answer.trim().length === 0) {
			fail('auto_answer rules need --answer "<reply text>"');
		}
	}

	let priority = 100;
	if (options.priority !== undefined) {
		const parsed = parseInt(options.priority, 10);
		if (isNaN(parsed)) fail('--priority must be an integer');
		priority = parsed;
	}

	const now = Date.now();
	const rule: PianolaRule = {
		id: generateUUID(),
		enabled: !options.disabled,
		scope,
		match,
		action: resolvedAction,
		priority,
		createdAt: now,
		updatedAt: now,
	};
	if (scope !== 'global' && options.scopeId) rule.scopeId = options.scopeId;
	if (resolvedAction === 'auto_answer' && options.answer) rule.answer = options.answer;
	if (options.description) rule.description = options.description;

	const existing = readPianolaRules();
	const written = writePianolaRules([...existing, rule]);
	// writePianolaRules drops anything that fails validation; if our new rule did
	// not survive, surface that instead of reporting a phantom success.
	if (!written.some((r) => r.id === rule.id)) {
		fail('Rule failed validation and was not saved');
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, rule, ruleCount: written.length }));
	} else {
		console.log(
			`Added Pianola rule ${rule.id} (${rule.scope} ${rule.action}). Total rules: ${written.length}`
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
