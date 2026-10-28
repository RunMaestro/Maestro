/**
 * Testing an agent's Run on target: one short turn through the real harness.
 *
 * The Test button in the Run on picker and `maestro-cli agent test-run-on` both
 * end here. A test is the agent's own launch, not an imitation of it: the
 * stored agent (or the form's unsaved values on top of it), the same
 * `prepareLaunchRunOn` and `buildAgentLaunchPlan` a chat turn goes through, the
 * same SSH wrapper for an agent on a remote. So a test that passes has proven
 * the route a turn will take (the source's address, its key, the model name,
 * the context the harness is told) and a test that is refused is refused with
 * the launch's own words.
 *
 * Three things set it apart from a turn:
 *
 *   - It is read-only. The model under test may be one nobody has run as an
 *     agent, in the user's own project directory, so it is not given write
 *     access to answer one word.
 *   - It never runs on the provider's model. A target that is Provider has
 *     nothing to test, and a plan that came back without the target applied
 *     ends the test before anything is spawned.
 *   - It has a budget. A model that loops is stopped and reported.
 */

import { redactSecrets } from '../../shared/redactSecrets';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import {
	agentRunOnSupport,
	parseRunOnTestRequest,
	resolveRunOnLaunch,
	RUN_ON_TEST_PROMPT,
	RUN_ON_TEST_REPLY_MAX_CHARS,
	storedRunOnNamesSource,
	type RunOnTarget,
	type RunOnTestFailureCode,
	type RunOnTestResult,
	type RunOnTestSubject,
} from '../../shared/local-models/run-on';
import { BACKGROUND_STOP_GRACE_MS } from '../../shared/maestro-lib/control/termination';
import { buildAgentLaunchPlan } from '../../shared/maestro-lib/launch/launch-plan';
import type { SshRemoteSettingsStore } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import { runToCompletion } from '../../shared/maestro-lib/run/run-to-completion';
import {
	turnProcessSpecFromPlan,
	type TurnProcessSpec,
} from '../../shared/maestro-lib/run/start-turn';
import { getAgentCapabilities, getAgentDefinition } from '../agents';
import { resolveCueAgentBinary } from '../cue/cue-agent-binary';
import { createOutputParser } from '../parsers';
import { planSpawnShell } from '../process-manager/utils/windowsSpawnShell';
import { applyAgentConfigOverrides, buildAgentArgs } from '../utils/agent-args';
import { logger } from '../utils/logger';
import { buildSpawnPath } from '../utils/spawnPath';
import { sshUnresolvedRemoteMessage, wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import { logRunOnLaunch, prepareLaunchRunOn, storedAgentRecord } from './run-on';

const LOG_CONTEXT = '[RunOnTest]';

/**
 * How long the turn itself may take. Loading the model is not in it: that
 * happens while the target is prepared, under the model server's own wait. A
 * cold first token from a large local model is the slow case this covers.
 */
export const RUN_ON_TEST_TURN_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunOnTestDeps {
	/** The provider-level config (Settings -> Agents) for one provider. */
	agentConfig: (toolType: string) => Record<string, unknown>;
	/** The path the agent detector found for a provider, or undefined. */
	detectedAgentPath: (toolType: string) => Promise<string | undefined>;
	/** Where an SSH remote is looked up. */
	sshStore: () => SshRemoteSettingsStore;
	/** Settings -> Environment, which a desktop launch layers under the agent's own vars. */
	shellEnvVars: () => Record<string, string>;
	/** Runs the turn. A seam for tests. */
	runTurn?: typeof runToCompletion;
}

let deps: RunOnTestDeps | null = null;

/** Point the test at this process's stores. Starts nothing. */
export function configureRunOnTest(next: RunOnTestDeps): void {
	deps = next;
}

/** Forget the stores, so each test starts from a process that was never configured. */
export function resetRunOnTestForTests(): void {
	deps = null;
}

function failure(
	code: RunOnTestFailureCode,
	message: string,
	durationMs?: number
): RunOnTestResult {
	return { ok: false, code, message, ...(durationMs === undefined ? {} : { durationMs }) };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A record's variables, or undefined for none: an empty set is not the agent's own set. */
function envVarsField(record: object | undefined, key: string): Record<string, string> | undefined {
	const value = (record as Record<string, unknown> | undefined)?.[key];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const vars = Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string'
		)
	);
	return Object.keys(vars).length > 0 ? vars : undefined;
}

/** What the harness said went wrong, short enough for one line and with no key in it. */
function failureDetail(text: string | undefined): string {
	const trimmed = (text ?? '').trim();
	if (trimmed === '') return '';
	const lines = trimmed.split('\n').filter((line) => line.trim() !== '');
	const tail = lines.slice(-3).join(' ').slice(-RUN_ON_TEST_REPLY_MAX_CHARS);
	return redactSecrets(tail).text;
}

/**
 * Send one short turn through an agent's harness on its Run on target and
 * report what came back. Never throws for a target that cannot run: every such
 * case is a result with the reason.
 */
export async function testAgentRunOn(rawRequest: unknown): Promise<RunOnTestResult> {
	if (!deps) {
		throw new Error('A Run on test was requested before configureRunOnTest() was called.');
	}
	const resolver = deps;
	const request = parseRunOnTestRequest(rawRequest);

	const stored = request.agentId ? storedAgentRecord(request.agentId) : undefined;
	if (request.agentId && !stored) {
		return failure('run-on-test-invalid-request', `No agent has the id "${request.agentId}".`);
	}

	const toolType = request.subject?.toolType ?? stringField(stored, 'toolType');
	if (!toolType) {
		return failure('run-on-test-invalid-request', 'A Run on test needs an agent or a provider.');
	}
	const agentName = getAgentDisplayName(toolType);

	const target = request.target !== undefined ? request.target : stored?.runOn;
	if (!storedRunOnNamesSource(target)) {
		return failure(
			'run-on-test-provider-target',
			`This agent runs on its provider's own model, so there is no source to test. Pick a model under Run on first.`
		);
	}

	// A form's launch settings are a set: what it leaves out is unset in the
	// form, not a gap to fill from the stored agent.
	const form = request.subject;
	const sshRemoteConfig = form
		? form.sshRemoteConfig
		: (stored?.sessionSshRemoteConfig as RunOnTestSubject['sshRemoteConfig']);
	const sshEnabled = !!sshRemoteConfig?.enabled;
	const cwd =
		form?.cwd ??
		(sshEnabled ? sshRemoteConfig?.workingDirOverride : undefined) ??
		stringField(stored, 'projectRoot') ??
		stringField(stored, 'cwd');
	if (!cwd) {
		return failure(
			'run-on-test-invalid-request',
			'A Run on test needs a working directory. Choose one for the agent first.'
		);
	}

	// A provider with no recipe is refused with the reason its picker shows,
	// ahead of anything about how its harness is started.
	if (!agentRunOnSupport(toolType).supported) {
		const refusal = resolveRunOnLaunch({ toolType, target: target as RunOnTarget });
		if (refusal.kind === 'refused') return failure(refusal.code, refusal.message);
	}

	const definition = getAgentDefinition(toolType);
	if (!definition) {
		return failure('run-on-test-not-startable', `Unknown provider "${toolType}".`);
	}
	const capabilities = getAgentCapabilities(toolType);
	if (!capabilities.supportsBatchMode) {
		return failure(
			'run-on-test-not-startable',
			`${agentName} cannot run a single turn without a terminal, so it cannot be tested.`
		);
	}
	if (!createOutputParser(toolType)) {
		return failure(
			'run-on-test-not-startable',
			`${agentName} has no output parser, so its reply could not be read.`
		);
	}

	const agentConfigValues = resolver.agentConfig(toolType);
	const sessionCustomPath = form ? form.customPath : stringField(stored, 'customPath');
	const sessionCustomArgs = form ? form.customArgs : stringField(stored, 'customArgs');
	const sessionEnvVars = envVarsField(form ?? stored, 'customEnvVars');
	const agentEnvVars = envVarsField(agentConfigValues, 'customEnvVars');

	// The precedence a tab spawn uses: the agent's own path, the provider's, then
	// what detection found. A bare command name is the last resort, and a spawn
	// that cannot find it is reported as a turn that did not start.
	const resolvedPath = await resolveCueAgentBinary({
		sessionCustomPath,
		providerCustomPath: stringField(agentConfigValues, 'customPath'),
		sshEnabled,
		getDetectedPath: () => resolver.detectedAgentPath(toolType),
		onWarn: (message) => logger.warn(message, LOG_CONTEXT),
	});
	const command = resolvedPath || definition.command;

	const agent = { ...definition, available: true, path: command, capabilities };
	let args = buildAgentArgs(agent, {
		baseArgs: definition.args,
		prompt: RUN_ON_TEST_PROMPT,
		cwd,
		permissionMode: 'readonly',
		// Nothing is attached to the turn but this function.
		forceBatchMode: true,
	});
	// The agent's own arguments and config options, as its turns get them. Its
	// model is left to the target, which replaces whatever is named here.
	args = applyAgentConfigOverrides(agent, args, {
		agentConfigValues,
		sessionCustomArgs,
		sessionCustomEnvVars: sessionEnvVars,
		readOnlyMode: true,
	}).args;

	const sshStore = resolver.sshStore();
	const prepared = await prepareLaunchRunOn({
		toolType,
		target,
		userEnvVars: sessionEnvVars ?? agentEnvVars,
		sshRemoteConfig,
		sshStore,
	});
	if (prepared.kind === 'refused') return failure(prepared.code, prepared.message);

	const planned = buildAgentLaunchPlan({
		surface: 'desktop',
		agent: { ...definition, capabilities },
		command,
		args,
		cwd,
		prompt: RUN_ON_TEST_PROMPT,
		globalShellEnvVars: resolver.shellEnvVars(),
		agentCustomEnvVars: agentEnvVars,
		sessionCustomEnvVars: sessionEnvVars,
		readOnlyMode: true,
		runOn: prepared.kind === 'ready' ? prepared.runOn : undefined,
		// A person pressed Test.
		querySource: 'user',
		sshRemoteConfig,
		sshStore,
	});
	if (!planned.ok) {
		// An SSH remote that cannot be resolved is the one refusal that is not a
		// Run on code.
		const code = planned.reason.startsWith('run-on-')
			? (planned.reason as RunOnTestFailureCode)
			: 'run-on-test-not-startable';
		return failure(code, planned.error);
	}
	const plan = planned.plan;
	if (!plan.runOn || prepared.kind !== 'ready') {
		// The target names a source, so a plan without it applied would send the
		// test turn to the provider's model. That must never be started.
		throw new Error('A Run on test was planned without its target applied.');
	}
	const sessionId = `run-on-test-${Date.now()}`;
	logRunOnLaunch(LOG_CONTEXT, { sessionId, toolType }, plan.runOn);

	let spec: TurnProcessSpec;
	// A remote plan carries no local environment: that is what tells them apart.
	if (plan.env === undefined) {
		const wrapped = await wrapSpawnWithSsh(
			{
				command: plan.command,
				args: plan.args,
				cwd: plan.cwd,
				prompt: RUN_ON_TEST_PROMPT,
				customEnvVars: plan.envVars,
				agentBinaryName: plan.command,
				promptArgs: definition.promptArgs,
				noPromptSeparator: definition.noPromptSeparator,
				querySource: 'user',
			},
			sshRemoteConfig,
			sshStore
		);
		if (!wrapped.sshRemoteUsed || !sshRemoteConfig) {
			// The plan resolved this remote a moment ago. Losing it now is still a
			// failure, never a reason to run the test on this machine.
			return failure(
				'run-on-test-not-startable',
				sshRemoteConfig
					? sshUnresolvedRemoteMessage(sshRemoteConfig)
					: 'The SSH remote for this agent is no longer configured.'
			);
		}
		spec = {
			command: wrapped.command,
			args: wrapped.args,
			cwd: wrapped.cwd,
			// The local ssh client inherits this process's environment; the
			// agent's own variables travel inside the ssh command or script.
			env: { ...process.env, PATH: buildSpawnPath(), ...(wrapped.customEnvVars ?? {}) },
			stdin: wrapped.sshStdinScript ?? wrapped.prompt,
		};
	} else {
		spec = turnProcessSpecFromPlan(plan);
		// The step a tab spawn takes: on Windows a harness installed as a `.cmd`
		// shim (npm installs Codex and OpenCode that way) cannot be spawned
		// directly and fails with "spawn EINVAL". Off Windows this changes nothing.
		const shellPlan = planSpawnShell(spec.command, spec.args, {});
		if (shellPlan.shell !== false) {
			spec = {
				...spec,
				command: shellPlan.command,
				args: shellPlan.args,
				shell: shellPlan.shell,
			};
		}
	}

	const startedAt = Date.now();
	const turn = await (resolver.runTurn ?? runToCompletion)(spec, {
		agentId: toolType,
		sessionId,
		label: 'run-on-test',
		stopGraceMs: BACKGROUND_STOP_GRACE_MS,
		signal: AbortSignal.timeout(RUN_ON_TEST_TURN_TIMEOUT_MS),
		// Codex `exec` announces it is reading stdin when handed an open pipe.
		emptyStdin: 'ignore',
	});
	const durationMs = Date.now() - startedAt;
	const reply = (turn.answerText ?? '').trim();

	const completed = turn.outcome === 'completed' || turn.outcome === 'completed-with-warning';
	if (completed && reply !== '') {
		return {
			ok: true,
			model: prepared.model,
			label: prepared.label,
			reply: reply.slice(0, RUN_ON_TEST_REPLY_MAX_CHARS),
			durationMs,
			contextTokens: plan.runOn.contextTokens,
		};
	}
	if (turn.outcome === 'interrupted') {
		return failure(
			'run-on-test-timeout',
			`${agentName} did not finish a turn on ${prepared.label} within ${Math.round(RUN_ON_TEST_TURN_TIMEOUT_MS / 60_000)} minutes, so the test stopped it.`,
			durationMs
		);
	}
	const detail =
		failureDetail(turn.error?.message) ||
		failureDetail(turn.exit.stderrText) ||
		(completed
			? 'the model returned an empty reply'
			: `the process exited with code ${turn.exit.exitCode ?? 'none'}`);
	return failure(
		'run-on-test-turn-failed',
		`${agentName} did not complete a turn on ${prepared.label}: ${detail.replace(/\.$/, '')}.`,
		durationMs
	);
}
