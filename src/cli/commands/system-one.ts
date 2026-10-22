// `maestro-cli s1 status|set|key|test|ledger` - the System One engine from the
// command line: which engine answers typed questions, where its key comes from,
// whether it answers, and what it decided.
//
// Every verb runs in the desktop over the WS bridge, through the same service
// functions the System One card in Settings > Models calls, so an engine chosen
// here is the one the card shows and the other way around.
//
//   status            the report: the engine, its address, model and budget,
//                     where each key comes from, and the fail policies
//   set engine        off | jev-cloud | openjev | local-judge, with --url (the
//                     OpenJev server) and --model (a pinned model; for the
//                     local judge, the source it answers on)
//   set timeout       the request budget for Jev and OpenJev, in milliseconds
//   set fail-policy   what one task does when the engine gives no answer
//   set keep-inputs   whether a decision record keeps what was asked, redacted
//   set agents        "Let agents use System One": whether an agent's own
//                     `s1 yes | pick | rate | ask | rank | batch` is answered
//   set budget        what agents may spend in a local day, across all of them
//                     and, with --per-agent, each
//   key set           store a key, read from STANDARD INPUT. It is never an
//                     argument, so it is never in shell history or a process list
//   key clear         forget the stored key
//   test              ask one fixed question; print the answer, latency, engine
//   ledger            the decisions of the last 30 days, newest first, by task,
//                     outcome and time
//
// No verb prints a key, and no reply from the app carries one.
//
// Exit codes, for scripts: `status` exits non-zero when the engine in force
// cannot answer as it is set up (no key, no URL, no model); `off` is not a
// failure. `test` exits non-zero when the engine gave no answer.

import { isStdinTerminal, readStdinText } from '../services/stdin';
import { ExitCode, exitWith } from '../exit-codes';
import {
	formatSuccess,
	formatSystemOneLedger,
	formatSystemOneReport,
	formatSystemOneTestResult,
	formatWarning,
} from '../output/formatter';
import { parseTimeInput } from '../../shared/computer-history/timeRange';
import {
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	type SystemOneRemoteEngineId,
} from '../../shared/local-models/system-one';
import {
	SYSTEM_ONE_LEDGER_MAX_LIMIT,
	SYSTEM_ONE_LEDGER_OUTCOME_FILTERS,
	isSystemOneLedgerOutcomeFilter,
	isSystemOneLedgerTaskId,
	type SystemOneLedgerPage,
	type SystemOneLedgerQuery,
} from '../../shared/local-models/system-one-ledger';
import {
	SYSTEM_ONE_AGENT_USE_DESCRIPTIONS,
	SYSTEM_ONE_ENGINE_CHOICES,
	SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS,
	SYSTEM_ONE_REMOTE_ENGINE_IDS,
	isSystemOneEngineChoice,
	isSystemOneRemoteEngineId,
	parseSystemOneBudgetText,
	systemOneAgentUseBlocker,
	systemOneFailPolicyProblem,
	systemOneKeyProblem,
	systemOneModelProblem,
	systemOneTimeoutProblem,
	systemOneUrlProblem,
	type SystemOneReport,
	type SystemOneSettingsPatch,
	type SystemOneTestResult,
} from '../../shared/local-models/system-one-settings';
import { formatSystemOneCost } from '../../shared/local-models/system-one-spend';
import { LOCAL_JUDGE_TASK_ID, localModelAssignmentCaution } from '../../shared/local-models/tasks';
import { resolveAssignmentSpec, storeTaskAssignment } from './models-assign';
import { failCommand, sendBridgeCommand } from '../services/session-command';

/** A status read or a settings write: one small file and no network. */
const STATUS_TIMEOUT_MS = 15_000;
/** A test waits for the engine. The local judge may load a model first. */
const TEST_TIMEOUT_MS = LOCAL_JUDGE_DEFAULT_TIMEOUT_MS + 15_000;

/** The word that removes a pin or a choice, as `--tier <tier>=default` spells it. */
const DEFAULT_WORD = 'default';

interface JsonOption {
	json?: boolean;
}

type ReportReply = { success: boolean; error?: string; report?: SystemOneReport };

/** One System One bridge round trip; `sendBridgeCommand()` with this group's timeout. */
export function send<T extends { success: boolean; error?: string }>(
	payload: Record<string, unknown>,
	responseType: string,
	json: boolean | undefined,
	timeoutMs = STATUS_TIMEOUT_MS
): Promise<T> {
	return sendBridgeCommand<T>(payload, responseType, json, timeoutMs);
}

function requireReport(reply: ReportReply, json: boolean | undefined): SystemOneReport {
	if (!reply.report) failCommand('The desktop app sent no System One report.', json);
	return reply.report;
}

export async function readStatus(json: boolean | undefined): Promise<SystemOneReport> {
	return requireReport(
		await send<ReportReply>({ type: 'system_one_status' }, 'system_one_status_result', json),
		json
	);
}

async function applyPatch(
	patch: SystemOneSettingsPatch,
	json: boolean | undefined
): Promise<SystemOneReport> {
	return requireReport(
		await send<ReportReply>({ type: 'system_one_set', patch }, 'system_one_set_result', json),
		json
	);
}

/** Print a report: the whole record as JSON, or the formatted block. */
function printReport(report: SystemOneReport, json: boolean | undefined): void {
	if (json) console.log(JSON.stringify({ success: report.problem === null, ...report }));
	else console.log(formatSystemOneReport(report));
}

export async function systemOneStatus(options: JsonOption): Promise<void> {
	const report = await readStatus(options.json);
	printReport(report, options.json);
	if (report.problem !== null) exitWith(ExitCode.GeneralError);
}

interface SetEngineOptions extends JsonOption {
	url?: string;
	model?: string;
}

export async function systemOneSetEngine(engine: string, options: SetEngineOptions): Promise<void> {
	const { json } = options;
	if (!isSystemOneEngineChoice(engine)) {
		failCommand(
			`"${engine}" is not an engine. Use ${SYSTEM_ONE_ENGINE_CHOICES.join(', ')}.`,
			json,
			ExitCode.InvalidUsage
		);
	}

	const patch: SystemOneSettingsPatch = { engine };
	if (options.url !== undefined) {
		if (engine !== 'openjev') {
			failCommand(
				'--url is the address of an OpenJev server. Use it with: s1 set engine openjev',
				json,
				ExitCode.InvalidUsage
			);
		}
		const problem = systemOneUrlProblem(options.url);
		if (problem) failCommand(problem, json, ExitCode.InvalidUsage);
		patch.openJevUrl = options.url;
	}

	// The local judge has no pin: its model is the Local judge task's
	// assignment, so `--model` is an assignment spelling and is stored the way
	// `models assign local-judge <source>` stores it.
	let judge: ReturnType<typeof resolveAssignmentSpec> | null = null;
	if (options.model !== undefined) {
		if (engine === 'off') {
			failCommand('--model needs an engine. Off answers nothing.', json, ExitCode.InvalidUsage);
		}
		if (engine === 'local-judge') {
			judge = resolveAssignmentSpec(LOCAL_JUDGE_TASK_ID, options.model);
			if (!judge.ok) failCommand(judge.message, json, ExitCode.InvalidUsage);
			if (judge.assignment.type !== 'local' && judge.assignment.type !== 'endpoint') {
				failCommand(
					'The local judge needs a model: local:<model-id> or endpoint:<endpoint>:<model>.',
					json,
					ExitCode.InvalidUsage
				);
			}
		} else if (options.model === DEFAULT_WORD) {
			patch.model = null;
		} else {
			const problem = systemOneModelProblem(options.model);
			if (problem) failCommand(problem, json, ExitCode.InvalidUsage);
			patch.model = options.model;
		}
	}

	if (engine === 'openjev' && options.url === undefined) {
		const current = await readStatus(json);
		if (!current.settings.openJevUrl) {
			failCommand(
				'OpenJev needs the URL of your server. Pass --url <url>.',
				json,
				ExitCode.InvalidUsage
			);
		}
	}

	if (judge?.ok) {
		// The assignment lives in the settings file, which this process writes
		// and the app reads at each use. Ask the app for its status first, so an
		// app that is not running fails here, before anything is stored; then
		// store the model, so the report that comes back with the engine names it.
		await readStatus(json);
		storeTaskAssignment(LOCAL_JUDGE_TASK_ID, judge.assignment);
	}
	const report = await applyPatch(patch, json);

	if (json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess(`System One engine: ${report.engineLabel}`));
	if (engine !== 'off') console.log(`  ${report.disclosure}`);
	if (judge?.ok) {
		const caution = localModelAssignmentCaution(LOCAL_JUDGE_TASK_ID, judge.assignment);
		if (caution) console.log(formatWarning(`Not recommended for this task: ${caution}`));
		if (!judge.endpointEnabled) {
			console.log(
				formatWarning('That endpoint is disabled. Enable it before the judge can answer.')
			);
		}
	}
	if (report.problem) console.log(formatWarning(report.problem));
	else if (engine !== 'off') console.log('  Check that it answers: maestro-cli s1 test');
}

export async function systemOneSetTimeout(value: string, options: JsonOption): Promise<void> {
	const timeoutMs = Number(value);
	const problem = systemOneTimeoutProblem(timeoutMs);
	if (problem) failCommand(problem, options.json, ExitCode.InvalidUsage);
	const report = await applyPatch({ timeoutMs }, options.json);
	if (options.json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess(`Jev and OpenJev requests get ${report.settings.timeoutMs} ms`));
	if (report.settings.engine === 'local-judge') {
		console.log(
			`  The local judge keeps its own budget (${LOCAL_JUDGE_DEFAULT_TIMEOUT_MS} ms): its first answer after an idle spell loads the model.`
		);
	}
}

export async function systemOneSetFailPolicy(
	taskId: string,
	policy: string,
	options: JsonOption
): Promise<void> {
	const problem = systemOneFailPolicyProblem(taskId, policy);
	if (problem) failCommand(problem, options.json, ExitCode.InvalidUsage);
	const report = await applyPatch(
		{ failPolicy: { taskId, policy: policy as 'open' | 'closed' | 'default' } },
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	const row = report.failPolicies.find((candidate) => candidate.taskId === taskId);
	if (!row) failCommand('The desktop app did not report that task.', options.json);
	console.log(
		formatSuccess(
			`${row.label} fails ${row.policy}${row.policy === row.defaultPolicy ? ' (its default)' : ''}`
		)
	);
}

export async function systemOneSetKeepInputs(value: string, options: JsonOption): Promise<void> {
	if (value !== 'on' && value !== 'off') {
		failCommand('Keep inputs in the ledger is on or off.', options.json, ExitCode.InvalidUsage);
	}
	const report = await applyPatch({ keepInputs: value === 'on' }, options.json);
	if (options.json) {
		printReport(report, true);
		return;
	}
	const stored = report.settings.keepInputs ? 'on' : 'off';
	console.log(formatSuccess(`Keep inputs in the ledger: ${stored}`));
	console.log(`  ${SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS[stored]}`);
	if (stored === 'off') {
		console.log('  Inputs already kept stay until their records are 30 days old.');
	}
}

/** "Let agents use System One": whether an agent's own `maestro-cli s1` request is answered. */
export async function systemOneSetAgents(value: string, options: JsonOption): Promise<void> {
	if (value !== 'on' && value !== 'off') {
		failCommand('Let agents use System One is on or off.', options.json, ExitCode.InvalidUsage);
	}
	const report = await applyPatch({ agents: { enabled: value === 'on' } }, options.json);
	if (options.json) {
		printReport(report, true);
		return;
	}
	const stored = report.settings.agents.enabled ? 'on' : 'off';
	console.log(formatSuccess(`Let agents use System One: ${stored}`));
	console.log(`  ${SYSTEM_ONE_AGENT_USE_DESCRIPTIONS[stored]}`);
	// On says what agents MAY do. Say so when the setup still stops them.
	const blocker = stored === 'on' ? systemOneAgentUseBlocker(report) : null;
	if (blocker) console.log(formatWarning(blocker));
	console.log('  Switch one agent off with: maestro-cli update-agent <agent-id> --system-one off');
}

interface SetBudgetOptions extends JsonOption {
	perAgent?: string;
}

/** The word that removes the per-agent cap. */
const NO_CAP_WORD = 'none';

/**
 * What agents may spend in a local day: `[usd]` across all of them, and
 * `--per-agent <usd|none>` for each. At least one of the two.
 */
export async function systemOneSetBudget(
	value: string | undefined,
	options: SetBudgetOptions
): Promise<void> {
	const { json } = options;
	const agents: NonNullable<SystemOneSettingsPatch['agents']> = {};
	if (value !== undefined) {
		const parsed = parseSystemOneBudgetText(value);
		if (!parsed.ok) failCommand(parsed.message, json, ExitCode.InvalidUsage);
		agents.dailyBudgetUsd = parsed.usd;
	}
	if (options.perAgent !== undefined) {
		if (options.perAgent.trim().toLowerCase() === NO_CAP_WORD) {
			agents.perAgentBudgetUsd = null;
		} else {
			const parsed = parseSystemOneBudgetText(options.perAgent);
			if (!parsed.ok) {
				failCommand(
					`--per-agent: ${parsed.message} Use "${NO_CAP_WORD}" to remove the cap.`,
					json,
					ExitCode.InvalidUsage
				);
			}
			agents.perAgentBudgetUsd = parsed.usd;
		}
	}
	if (Object.keys(agents).length === 0) {
		failCommand(
			'Give the daily budget in US dollars, --per-agent <usd|none>, or both.',
			json,
			ExitCode.InvalidUsage
		);
	}

	const report = await applyPatch({ agents }, json);
	if (json) {
		printReport(report, true);
		return;
	}
	const stored = report.settings.agents;
	console.log(
		formatSuccess(
			`Agents may spend ${formatSystemOneCost(stored.dailyBudgetUsd)} a day on System One, across all of them`
		)
	);
	console.log(
		stored.perAgentBudgetUsd === null
			? '  No agent has a cap of its own.'
			: `  One agent may spend ${formatSystemOneCost(stored.perAgentBudgetUsd)} a day.`
	);
	if (stored.dailyBudgetUsd === 0 || stored.perAgentBudgetUsd === 0) {
		console.log(formatWarning('A budget of 0 refuses every agent request.'));
	} else if (report.settings.engine === 'openjev' || report.settings.engine === 'local-judge') {
		console.log('  The engine in force has no price, so a budget above 0 never binds.');
	}
	console.log('  The day starts at local midnight. See the spend with: maestro-cli s1 usage');
}

interface KeyOptions extends JsonOption {
	engine?: string;
}

/** The engine a key verb names, checked. Absent means the engine in force. */
function keyEngine(options: KeyOptions): SystemOneRemoteEngineId | undefined {
	if (options.engine === undefined) return undefined;
	if (!isSystemOneRemoteEngineId(options.engine)) {
		failCommand(
			`"${options.engine}" has no key. A key belongs to ${SYSTEM_ONE_REMOTE_ENGINE_IDS.join(' or ')}.`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	return options.engine;
}

/**
 * Read the key from standard input. A terminal is refused: a key typed at a
 * prompt this command does not hide would be on the screen, and a key given as
 * an argument would be in shell history.
 */
function readKeyFromStdin(json: boolean | undefined): string {
	if (isStdinTerminal()) {
		failCommand(
			'Pipe the key on standard input, for example: pbpaste | maestro-cli s1 key set',
			json,
			ExitCode.InvalidUsage
		);
	}
	let text: string;
	try {
		text = readStdinText();
	} catch {
		failCommand('Could not read the key from standard input.', json);
	}
	const key = text.trim();
	const problem = systemOneKeyProblem(key);
	if (problem) failCommand(problem, json, ExitCode.InvalidUsage);
	return key;
}

export async function systemOneKeySet(options: KeyOptions): Promise<void> {
	const engine = keyEngine(options);
	const key = readKeyFromStdin(options.json);
	const report = requireReport(
		await send<ReportReply>(
			{ type: 'system_one_key_set', key, ...(engine ? { engine } : {}) },
			'system_one_key_set_result',
			options.json
		),
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	const stored = SYSTEM_ONE_REMOTE_ENGINE_IDS.find(
		(id) => (engine ?? report.settings.engine) === id
	);
	const info = stored ? report.keys[stored] : undefined;
	console.log(formatSuccess(`Stored the key${stored ? ` for ${stored}` : ''}`));
	if (info?.source === 'stored' && info.storage === 'obscured') {
		console.log(
			formatWarning('This system has no key store, so the key is stored obscured, not encrypted.')
		);
	}
}

export async function systemOneKeyClear(options: KeyOptions): Promise<void> {
	const engine = keyEngine(options);
	const report = requireReport(
		await send<ReportReply>(
			{ type: 'system_one_key_clear', ...(engine ? { engine } : {}) },
			'system_one_key_clear_result',
			options.json
		),
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess('Cleared the stored key'));
	const cleared = engine ?? report.settings.engine;
	const info = isSystemOneRemoteEngineId(cleared) ? report.keys[cleared] : undefined;
	if (info && info.source !== 'none' && info.source !== 'stored') {
		console.log(`  ${cleared} still has a key from another source. See: maestro-cli s1 status`);
	}
}

export async function systemOneTest(options: JsonOption): Promise<void> {
	const reply = await send<{ success: boolean; error?: string; result?: SystemOneTestResult }>(
		{ type: 'system_one_test' },
		'system_one_test_result',
		options.json,
		TEST_TIMEOUT_MS
	);
	const result = reply.result;
	if (!result) failCommand('The desktop app sent no test result.', options.json);
	if (options.json) console.log(JSON.stringify({ success: result.ok, ...result }));
	else console.log(formatSystemOneTestResult(result));
	if (!result.ok) exitWith(ExitCode.GeneralError);
}

interface LedgerOptions extends JsonOption {
	task?: string;
	outcome?: string;
	since?: string;
	limit?: string;
}

export async function systemOneLedger(options: LedgerOptions): Promise<void> {
	const { json } = options;
	const query: SystemOneLedgerQuery = {};
	if (options.task !== undefined) {
		if (!isSystemOneLedgerTaskId(options.task)) {
			failCommand(
				`"${options.task}" is not a task. List them with: maestro-cli models tasks. An agent's own requests are filed under agent:<verb>, for example agent:rank.`,
				json,
				ExitCode.InvalidUsage
			);
		}
		query.taskId = options.task;
	}
	if (options.outcome !== undefined) {
		if (!isSystemOneLedgerOutcomeFilter(options.outcome)) {
			failCommand(
				`"${options.outcome}" is not an outcome. Use ${SYSTEM_ONE_LEDGER_OUTCOME_FILTERS.join(', ')}.`,
				json,
				ExitCode.InvalidUsage
			);
		}
		query.outcome = options.outcome;
	}
	if (options.since !== undefined) {
		const since = parseTimeInput(options.since, Date.now());
		if (since === null) {
			failCommand(
				`"${options.since}" is not a time. Use 30m, 2h, 1d, 1w, ISO-8601, or epoch.`,
				json,
				ExitCode.InvalidUsage
			);
		}
		query.since = since;
	}
	if (options.limit !== undefined) {
		const limit = Number(options.limit);
		if (!Number.isInteger(limit) || limit < 1 || limit > SYSTEM_ONE_LEDGER_MAX_LIMIT) {
			failCommand(
				`The limit must be a whole number from 1 to ${SYSTEM_ONE_LEDGER_MAX_LIMIT}.`,
				json,
				ExitCode.InvalidUsage
			);
		}
		query.limit = limit;
	}

	const reply = await send<{ success: boolean; error?: string; page?: SystemOneLedgerPage }>(
		{ type: 'system_one_ledger', query },
		'system_one_ledger_result',
		json
	);
	if (!reply.page) failCommand('The desktop app sent no ledger.', json);
	if (json) console.log(JSON.stringify({ success: true, ...reply.page }));
	else console.log(formatSystemOneLedger(reply.page));
}
