/**
 * Run on, for the agents `maestro-cli` launches in its own process: `send`,
 * Auto Run and playbooks, goal runs, the synopsis, and the standalone Cue
 * engine.
 *
 * The decision is the app's own (`prepareAgentRunOn` in
 * `src/main/local-models/run-on.ts`, then the launch plan). What differs is
 * where this process finds a source:
 *
 *   - A saved source (Ollama, LM Studio, a cloud endpoint) is read from the
 *     settings file, and its key from Settings -> Environment in that file, the
 *     same two places the app reads. It needs no running app.
 *   - The Maestro model server is supervised by the app, so this process asks
 *     the running app to make it ready and takes its address and key from the
 *     answer. With the app closed that fails, and the launch is refused by
 *     name: it never runs on the provider's model instead.
 */

import type { AgentRunOnPreparation, RunOnModelServer } from '../../main/local-models/run-on';
import { MODEL_SERVER_NAME } from '../../shared/local-models/model-server';
import {
	parseRunOnEdit,
	parseRunOnSpec,
	parseRunOnTarget,
	runOnContextProblem,
	runOnDefaultContextTokens,
	storedRunOnNamesSource,
	type RunOnSourceTarget,
} from '../../shared/local-models/run-on';
import type { AgentSshRemoteConfig } from '../../shared/types';
import { withMaestroClient } from './maestro-client';
import { readLocalModelEndpoints, readSessions, readSettingValue, readSshRemotes } from './storage';

/**
 * How long the app may take to answer. A first start can take a minute, and a
 * large model can take ten to load (the supervisor's own budgets).
 */
const MODEL_SERVER_ENSURE_TIMEOUT_MS = 12 * 60 * 1000;

interface EnsureReply {
	success: boolean;
	error?: string;
	baseUrl?: string;
	key?: string;
}

/** Ask the running app to make the model server ready for `model`. */
async function modelServerFromApp(model: string): Promise<RunOnModelServer> {
	let reply: EnsureReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<EnsureReply>(
				{ type: 'local_models_server_ensure', model },
				'local_models_server_ensure_result',
				MODEL_SERVER_ENSURE_TIMEOUT_MS
			)
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `the ${MODEL_SERVER_NAME} runs inside the Maestro app, which could not be asked for it: ${reason}`,
		};
	}
	if (!reply.success) return { ok: false, error: reply.error || 'the Maestro app gave no reason' };
	if (!reply.baseUrl || !reply.key) {
		return { ok: false, error: 'the Maestro app did not say where the server listens' };
	}
	return { ok: true, baseUrl: reply.baseUrl, key: reply.key };
}

function shellEnvVars(): Record<string, string> {
	const value = readSettingValue('shellEnvVars');
	return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

/**
 * Point Run on at this process's view of the stores. Reads nothing until a
 * launch needs it. Safe to call more than once.
 */
export async function configureCliRunOn(): Promise<void> {
	const runOn = await import('../../main/local-models/run-on');
	if (runOn.isAgentRunOnConfigured()) return;
	runOn.configureAgentRunOn({
		sessions: () => readSessions() as unknown as Array<Record<string, unknown>>,
		endpoints: () => readLocalModelEndpoints(),
		shellEnvVars,
		modelServer: modelServerFromApp,
	});
}

export interface CliRunOnRequest {
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The agent's stored `runOn`, as data. */
	target: unknown;
	/** The agent's effective custom vars; a recipe variable set here wins. */
	userEnvVars?: Record<string, string>;
	sshRemoteConfig?: AgentSshRemoteConfig;
}

/**
 * Look a CLI launch's Run on target up, ready for `buildAgentLaunchPlan`. An
 * agent on its provider's model costs one parse: nothing is imported, read or
 * asked.
 */
export async function prepareCliRunOn(request: CliRunOnRequest): Promise<AgentRunOnPreparation> {
	if (!storedRunOnNamesSource(request.target)) return { kind: 'none' };

	await configureCliRunOn();
	const { prepareLaunchRunOn } = await import('../../main/local-models/run-on');
	return prepareLaunchRunOn({
		toolType: request.toolType,
		target: request.target,
		userEnvVars: request.userEnvVars,
		sshRemoteConfig: request.sshRemoteConfig,
		sshStore: { getSshRemotes: () => readSshRemotes() },
	});
}

/** `--run-on` and `--run-on-context`, as typed. */
export interface RunOnFlags {
	runOn?: string;
	runOnContext?: string;
}

export type RunOnFlagsEdit =
	/** Neither flag was passed: the agent's target is left alone. */
	| { kind: 'unchanged' }
	/** Store this. `undefined` is the provider's own model: no target on the record. */
	| { kind: 'set'; target: RunOnSourceTarget | undefined }
	| { kind: 'refused'; error: string };

/**
 * Read `create-agent` / `update-agent`'s Run on flags into the target the
 * Models tab's picker would store for the same choice.
 *
 * - `--run-on provider` clears the target.
 * - `--run-on <source id>:<model>` names one. With no `--run-on-context` the
 *   context is the one the picker's field starts at (`runOnDefaultContextTokens`),
 *   unless the agent already runs on that source and model: naming the same
 *   target again keeps the context it has, as re-picking it in the dialog does.
 * - `--run-on-context <n>` alone changes the context of the target the agent
 *   already has, which is the picker's context field on its own.
 *
 * The target is checked with `parseRunOnEdit` against the agent's provider and
 * the saved sources, so a typed id that names nothing is refused here and not
 * at the agent's next launch. Whether the source serves the model is not asked:
 * that needs the network, and `agent test-run-on` is the verb for it.
 */
export function readRunOnFlags(
	flags: RunOnFlags,
	agent: { toolType: string; runOn?: unknown }
): RunOnFlagsEdit {
	if (flags.runOn === undefined && flags.runOnContext === undefined) return { kind: 'unchanged' };

	let contextTokens: number | undefined;
	if (flags.runOnContext !== undefined) {
		const raw = flags.runOnContext.trim();
		if (!/^\d+$/.test(raw)) {
			return {
				kind: 'refused',
				error: `--run-on-context expects a whole number of tokens, got "${flags.runOnContext}"`,
			};
		}
		contextTokens = Number(raw);
		const problem = runOnContextProblem(contextTokens);
		if (problem) return { kind: 'refused', error: `--run-on-context: ${problem}` };
	}

	const storedParse = parseRunOnTarget(agent.runOn);
	const stored =
		storedParse.ok && storedParse.target.type === 'source' ? storedParse.target : undefined;

	let named: Pick<RunOnSourceTarget, 'endpointId' | 'model'>;
	if (flags.runOn === undefined) {
		if (!stored) {
			return {
				kind: 'refused',
				error:
					"--run-on-context sets the context size of a Run on source, and this agent runs on its provider's model. Pass --run-on <source id>:<model> with it.",
			};
		}
		named = stored;
	} else {
		const spec = parseRunOnSpec(flags.runOn);
		if (!spec.ok) return { kind: 'refused', error: `--run-on: ${spec.error}` };
		if (spec.target.type === 'provider') {
			if (contextTokens !== undefined) {
				return {
					kind: 'refused',
					error:
						'--run-on-context does not apply to --run-on provider: the provider sets its own context.',
				};
			}
			return { kind: 'set', target: undefined };
		}
		named = spec.target;
	}

	const sameAsStored =
		stored !== undefined && stored.endpointId === named.endpointId && stored.model === named.model;
	const edit = parseRunOnEdit(
		agent.toolType,
		{
			type: 'source',
			endpointId: named.endpointId,
			model: named.model,
			contextTokens:
				contextTokens ??
				(sameAsStored ? stored.contextTokens : undefined) ??
				runOnDefaultContextTokens(named),
		},
		readLocalModelEndpoints()
	);
	if (!edit.ok) return { kind: 'refused', error: `--run-on: ${edit.error}` };
	return { kind: 'set', target: edit.target };
}
