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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSettingValue } from '../services/storage';
import {
	readPianolaRules,
	readPianolaRulesResult,
	writePianolaRules,
	appendPianolaDecision,
	readPianolaDecisions,
	getPianolaProfile,
	setPianolaProfile,
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
	type PianolaJudgmentRequest,
} from '../../shared/pianola/pianola-watcher';
import { matchHasNarrowingPredicate } from '../../shared/pianola/pianola-policy';
import {
	parseClaudeTranscriptLine,
	parseCodexTranscriptLine,
	parseClaudeCwd,
	parseCodexCwd,
	extractDecisionPairs,
	aggregateDecisionPairs,
	type DecisionPair,
	type TranscriptAgent,
} from '../../shared/pianola/transcript-mining';
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

/**
 * Build the message handed to Pianola when the rules do not cover an ask. It
 * gives Pianola the waiting agent, the ask, and the user's decision profile for
 * that project, and tells it how to either answer the agent or escalate to the
 * user. Pianola runs this in its own chat, so `$MAESTRO_CLI_JS` is written
 * literally for Pianola's shell to expand.
 */
function buildPianolaHandoffPrompt(request: PianolaJudgmentRequest): string {
	const { target, classification, profile, promptText, options } = request;
	const lines: string[] = [
		'A watched agent is waiting on a decision and no rule covers it. Judge it the way the user would, using their decision profile for this project.',
		'',
		`Agent: ${target.agentId}`,
		`Tab: ${target.tabId}`,
		`Project: ${target.projectPath ?? '(unknown)'}`,
		`Ask (${classification.kind}, risk ${classification.risk}): ${classification.topic}`,
	];
	if (promptText) lines.push('', 'The agent said:', promptText.trim());
	if (options && options.length > 0) lines.push('', `Options offered: ${options.join(' | ')}`);
	lines.push(
		'',
		"User's decision profile for this project:",
		'---',
		profile.profile.trim(),
		'---',
		'',
		'Decide:',
		'- If the profile makes the right answer clear and this is safe and reversible, answer the agent now:',
		`  node "$MAESTRO_CLI_JS" dispatch ${target.agentId} "<your answer>" --tab ${target.tabId}`,
		'- If you are not confident, or it is sensitive or irreversible, do NOT answer. Tell the user what is waiting and ask them to decide.',
		'Never answer a high-risk ask without the user.'
	);
	return lines.join('\n');
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

	// Thought-based handoff path: only when we know which agent IS Pianola (set in
	// the watch process's env when Pianola spawns the watch). Without it, the watch
	// stays purely rule-driven and uncovered asks escalate to the user as before.
	const pianolaAgentId = process.env.MAESTRO_AGENT_ID;
	if (pianolaAgentId) {
		deps.resolveProfile = (projectPath) => getPianolaProfile(projectPath).entry;
		deps.requestJudgment = async (request) => {
			// Never hand an ask back to Pianola's own tab (it never watches itself,
			// but guard against a misconfigured --agent pointing at Pianola).
			if (request.target.agentId === pianolaAgentId) {
				return { success: false, error: 'target agent is Pianola itself' };
			}
			const message = buildPianolaHandoffPrompt(request);
			const res = await runDispatch(pianolaAgentId, message, {});
			return { success: !!res.success, error: res.error };
		};
	}

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

const LEARN_MAX_FILE_BYTES = 50 * 1024 * 1024; // skip transcripts larger than 50 MB
const LEARN_DEFAULT_SESSION_LIMIT = 300; // per agent, newest first
const LEARN_DEFAULT_STDOUT_PAIRS = 200; // pairs printed inline when no --out

export interface PianolaLearnOptions {
	agent?: string;
	limit?: string;
	out?: string;
	maxPairs?: string;
	since?: string;
	project?: string;
	exclude?: string;
	json?: boolean;
}

/** Recursively collect files under a directory whose name matches `match`. */
function collectTranscriptFiles(
	dir: string,
	match: (name: string) => boolean
): { path: string; mtime: number }[] {
	const out: { path: string; mtime: number }[] = [];
	const walk = (d: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return; // unreadable dir (missing/permission) - skip
		}
		for (const entry of entries) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (match(entry.name)) {
				try {
					out.push({ path: full, mtime: fs.statSync(full).mtimeMs });
				} catch {
					// unreadable file - skip
				}
			}
		}
	};
	walk(dir);
	return out;
}

/** Read a transcript file's lines, skipping anything too large to mine safely. */
function readTranscriptLines(file: string): string[] | null {
	try {
		const stat = fs.statSync(file);
		if (stat.size > LEARN_MAX_FILE_BYTES) return null;
		return fs.readFileSync(file, 'utf-8').split('\n');
	} catch {
		return null;
	}
}

/** Mine one transcript file into decision pairs using the per-agent parser. */
function minePairsFromFile(agent: TranscriptAgent, file: string): DecisionPair[] {
	const lines = readTranscriptLines(file);
	if (!lines) return [];
	const sessionId = path.basename(file, '.jsonl');
	const messages: PianolaMessage[] = [];
	let projectPath: string | undefined;
	for (const line of lines) {
		const parsed =
			agent === 'claude-code' ? parseClaudeTranscriptLine(line) : parseCodexTranscriptLine(line);
		if (parsed) messages.push(parsed);
		if (!projectPath) {
			projectPath = agent === 'claude-code' ? parseClaudeCwd(line) : parseCodexCwd(line);
		}
	}
	if (messages.length === 0) return [];
	return extractDecisionPairs(messages, { agent, sessionId, projectPath });
}

/**
 * Crawl the installed CLIs' native transcripts and emit a labeled decision
 * corpus: every awaiting-input moment paired with how the user actually replied,
 * classified via the shared brain. This is the raw material Pianola synthesizes
 * its decision profile and hard-rule suggestions from. Output is JSON for Pianola
 * to consume (compact with --json); use --out to write the full corpus to a file.
 */
export function pianolaLearn(options: PianolaLearnOptions): void {
	ensurePianolaEnabled(options.json);

	const requested = (options.agent ?? 'claude-code,codex')
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean);
	const agents: TranscriptAgent[] = [];
	for (const a of requested) {
		if ((a === 'claude-code' || a === 'codex') && !agents.includes(a)) agents.push(a);
	}
	if (agents.length === 0) {
		const message = '--agent must include claude-code and/or codex';
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
	}

	const sessionLimit = options.limit
		? Math.max(1, parseInt(options.limit, 10) || LEARN_DEFAULT_SESSION_LIMIT)
		: LEARN_DEFAULT_SESSION_LIMIT;

	// --since filters transcripts by last-modified date (cheap, before parsing).
	let sinceMs = 0;
	if (options.since) {
		const parsed = Date.parse(options.since);
		if (isNaN(parsed)) {
			const message = `--since must be a date (e.g. 2026-06-01), got "${options.since}"`;
			if (options.json) console.log(JSON.stringify({ success: false, error: message }));
			else console.error(message);
			process.exit(1);
		}
		sinceMs = parsed;
	}

	// --project / --exclude scope by the session's originating path (cwd), so the
	// user can learn from representative work and drop noise (e.g. dev sessions).
	const projectNeedle = options.project?.toLowerCase();
	const excludeNeedle = options.exclude?.toLowerCase();

	const home = os.homedir();
	const allPairs: DecisionPair[] = [];
	const scanned: Record<string, { files: number; sessionsWithDecisions: number }> = {};

	for (const agent of agents) {
		const dir =
			agent === 'claude-code'
				? path.join(home, '.claude', 'projects')
				: path.join(home, '.codex', 'sessions');
		const match =
			agent === 'claude-code'
				? (n: string): boolean => n.endsWith('.jsonl')
				: (n: string): boolean => /^rollout-.*\.jsonl$/i.test(n);
		const files = collectTranscriptFiles(dir, match)
			.filter((f) => f.mtime >= sinceMs)
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, sessionLimit);
		let sessionsWithDecisions = 0;
		for (const file of files) {
			let pairs = minePairsFromFile(agent, file.path);
			// Path-scope filters: a pair with no known projectPath is kept only when
			// no --project filter is set (we cannot confirm a match), and is never
			// dropped by --exclude (we cannot confirm exclusion).
			if (projectNeedle) {
				pairs = pairs.filter((p) => p.projectPath?.toLowerCase().includes(projectNeedle));
			}
			if (excludeNeedle) {
				pairs = pairs.filter((p) => !p.projectPath?.toLowerCase().includes(excludeNeedle));
			}
			if (pairs.length > 0) sessionsWithDecisions += 1;
			allPairs.push(...pairs);
		}
		scanned[agent] = { files: files.length, sessionsWithDecisions };
	}

	const aggregates = aggregateDecisionPairs(allPairs);
	const totalFiles = Object.values(scanned).reduce((n, s) => n + s.files, 0);

	if (options.out) {
		const outPath = path.resolve(options.out);
		fs.writeFileSync(
			outPath,
			JSON.stringify({ scanned, pairCount: allPairs.length, aggregates, pairs: allPairs }, null, 2),
			'utf-8'
		);
		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					scanned,
					pairCount: allPairs.length,
					aggregates,
					out: outPath,
				})
			);
		} else {
			console.log(
				`Mined ${allPairs.length} decision(s) from ${totalFiles} transcript(s). Full corpus written to ${outPath}`
			);
		}
		return;
	}

	const maxPairs = options.maxPairs
		? Math.max(0, parseInt(options.maxPairs, 10) || LEARN_DEFAULT_STDOUT_PAIRS)
		: LEARN_DEFAULT_STDOUT_PAIRS;
	const payload = {
		success: true,
		scanned,
		pairCount: allPairs.length,
		aggregates,
		pairs: allPairs.slice(0, maxPairs),
		truncated: allPairs.length > maxPairs,
	};
	console.log(JSON.stringify(payload, null, options.json ? 0 : 2));
}

export interface PianolaProfileReadOptions {
	project?: string;
	json?: boolean;
}

/**
 * Read a learned decision profile. With --project, returns that project's profile
 * (falling back to the global one); without it, returns the global profile. This
 * is how the watcher and Pianola fetch "how the user decides here" at decision time.
 */
export function pianolaProfile(options: PianolaProfileReadOptions): void {
	ensurePianolaEnabled(options.json);
	const { source, entry } = getPianolaProfile(options.project);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				source,
				projectPath: options.project ?? null,
				profile: entry?.profile ?? null,
				updatedAt: entry?.updatedAt ?? null,
				pairCount: entry?.pairCount ?? null,
			})
		);
		return;
	}

	if (!entry) {
		console.log(
			options.project
				? `No profile for ${options.project} (and no global profile set).`
				: 'No global Pianola profile set.'
		);
		return;
	}
	const scope = source === 'project' ? `project ${options.project}` : 'global';
	console.log(`Pianola profile (${scope}), updated ${new Date(entry.updatedAt).toISOString()}:`);
	console.log(entry.profile);
}

export interface PianolaSetProfileOptions {
	project?: string;
	file?: string;
	pairCount?: string;
	json?: boolean;
}

/**
 * Save a learned decision profile (per-project with --project, else global). This
 * is how Pianola persists what it synthesized from `pianola learn`. The profile
 * text comes from --file or piped stdin (preferred for multi-line markdown).
 */
export function pianolaSetProfile(options: PianolaSetProfileOptions): void {
	ensurePianolaEnabled(options.json);

	const fail = (message: string): never => {
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
	};

	let profileText: string;
	if (options.file) {
		try {
			profileText = fs.readFileSync(path.resolve(options.file), 'utf-8');
		} catch (error) {
			return fail(
				`Could not read --file: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	} else if (process.stdin.isTTY) {
		return fail('Provide the profile via --file <path> or piped stdin');
	} else {
		try {
			profileText = fs.readFileSync(0, 'utf-8');
		} catch {
			return fail('Could not read the profile from stdin; use --file <path> instead');
		}
	}

	if (!profileText.trim()) return fail('Profile content is empty');

	let pairCount: number | undefined;
	if (options.pairCount !== undefined) {
		const parsed = parseInt(options.pairCount, 10);
		if (!isNaN(parsed)) pairCount = parsed;
	}

	const entry = {
		profile: profileText,
		updatedAt: Date.now(),
		...(pairCount !== undefined ? { pairCount } : {}),
	};
	setPianolaProfile(entry, options.project);

	const scope = options.project ? `project ${options.project}` : 'global';
	if (options.json) {
		console.log(JSON.stringify({ success: true, scope, chars: profileText.length }));
	} else {
		console.log(`Saved ${scope} Pianola profile (${profileText.length} chars).`);
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
