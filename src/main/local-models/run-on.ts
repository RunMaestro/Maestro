/**
 * Run on, in a process that can reach the sources.
 *
 * `resolveRunOnLaunch` (shared) decides what an agent's Run on target does to a
 * launch from data it is handed. This module hands it that data: the source's
 * record, its key, and the answer to "can this source serve the model right
 * now". Every spawn surface goes through it, so none can send a turn to the
 * provider's model because it looked the target up another way:
 *
 *   - A surface that builds a launch plan (desktop, Cue, the CLI) calls
 *     `prepareLaunchRunOn()` and hands the result to `buildAgentLaunchPlan`.
 *   - A surface that builds none (a Group Chat participant, a cross-agent
 *     consult) calls `applyAgentRunOnToSpawn()`, which does both steps.
 *   - A caller that sends a source a request itself, with no harness in between
 *     (the token proxy's background routing), calls `resolveSourceCallTarget()`.
 *
 * What it reaches is injected (`configureAgentRunOn`), because two processes
 * run this code. The desktop app reads its own stores and starts its own model
 * server. `maestro-cli` reads the same settings from disk and asks the running
 * app for the model server, which only the app can start. Neither default is
 * built in: an unconfigured process that met a source target could only guess,
 * and a guess here means the provider's model.
 *
 * Order matters. The refusals that need no network (an unsupported provider, a
 * source that is gone or disabled, a loopback source for an SSH remote) are
 * decided first, so a launch that will be refused never starts the model
 * server or loads a model for nothing.
 */

import { applyEnvVarMerges } from '../../shared/agentEnvironment';
import {
	resolveEndpointApiKey,
	type LocalModelEndpoint,
} from '../../shared/local-models/endpoints';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_LOOPBACK_HOST,
	modelServerEndpoint,
} from '../../shared/local-models/model-server';
import {
	agentRunOnSupport,
	parseRunOnTarget,
	resolveRunOnLaunch,
	runOnTargetLabel,
	runOnUnavailable,
	storedRunOnNamesSource,
	type ResolvedRunOn,
	type RunOnRefusal,
	type RunOnSourceTarget,
	type RunOnTarget,
} from '../../shared/local-models/run-on';
import {
	applyRunOnToLaunch,
	type LaunchPlanAgent,
	type LaunchPlanRunOn,
} from '../../shared/maestro-lib/launch/launch-plan';
import {
	resolveSshLaunchTarget,
	type SshRemoteSettingsStore,
} from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import type { AgentSshRemoteConfig } from '../../shared/types';
import { logger } from '../utils/logger';
import { listEndpointModels, type EndpointModel } from './endpoint-client';
import { isLocalModelEndpointError } from './errors';

/** How many of a source's models a "does not serve" refusal names. */
const SERVED_MODELS_SHOWN = 5;

/** The Maestro model server, ready for one model, or why it is not. */
export type RunOnModelServer =
	| { ok: true; baseUrl: string; key: string }
	| { ok: false; error: string };

export interface AgentRunOnDeps {
	/** The stored agent records (the sessions store). */
	sessions: () => Array<Record<string, unknown>>;
	/** The saved endpoints (`localModelEndpoints`), read through their validator. */
	endpoints: () => LocalModelEndpoint[];
	/** Settings -> Environment, where a source's key is looked up by name. */
	shellEnvVars: () => Record<string, string>;
	/**
	 * Make the Maestro model server ready to serve `model` (start it and load
	 * the model when needed) and say where it listens and what its key is.
	 */
	modelServer: (model: string) => Promise<RunOnModelServer>;
	/** Lists what a source serves. A seam for tests. */
	listModels?: typeof listEndpointModels;
}

let deps: AgentRunOnDeps | null = null;

/** Point Run on at this process's stores and model server. Starts nothing. */
export function configureAgentRunOn(next: AgentRunOnDeps): void {
	deps = next;
}

/** Whether this process has been given its stores. */
export function isAgentRunOnConfigured(): boolean {
	return deps !== null;
}

function requireDeps(): AgentRunOnDeps {
	if (!deps) {
		// A programming error, and one that must not be survivable: carrying on
		// would run the agent on its provider's model.
		throw new Error(
			'An agent with a Run on target was launched before configureAgentRunOn() was called.'
		);
	}
	return deps;
}

/** One stored agent record, as data. Undefined for no agent, and before the stores are wired. */
export function storedAgentRecord(agentId: string): Record<string, unknown> | undefined {
	return deps?.sessions().find((record) => record?.id === agentId);
}

/** The stored `runOn` of one agent, as data. Undefined for no agent and no target. */
export function storedAgentRunOn(agentId: string): unknown {
	return storedAgentRecord(agentId)?.runOn;
}

export interface AgentRunOnRequest {
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The agent's stored `runOn`, as data: it is validated here. */
	target: unknown;
	/** The agent's effective custom vars; a recipe variable set here wins. */
	userEnvVars?: Record<string, string>;
	/** The SSH remote the process runs on, when it runs on one. */
	remote?: { name: string } | null;
}

export type AgentRunOnPreparation =
	/** The agent runs on its provider's own model. */
	| { kind: 'none' }
	/** The source can serve the model: hand `runOn` to the launch plan. */
	| { kind: 'ready'; runOn: ResolvedRunOn; model: string; label: string }
	/** The launch must fail with this message. */
	| RunOnRefusal;

/** A target's source as the stores have it, before anything is asked of it. */
interface KnownSource {
	/** Whether the target names the Maestro model server. */
	onServer: boolean;
	/**
	 * The source's record: a saved endpoint, or the model server at its loopback
	 * host. The server's port is chosen at its first start, but its host is not
	 * in doubt, and that is all a check made before it starts reads from its
	 * record. Null when no such source is configured.
	 */
	endpoint: LocalModelEndpoint | null;
	/** Settings -> Environment. Read only for a saved source. */
	shellEnvVars: Record<string, string>;
	/** A saved source's key. The model server hands its own over when it is ready. */
	key: string | undefined;
}

function lookUpSource(resolver: AgentRunOnDeps, target: RunOnSourceTarget): KnownSource {
	const onServer = target.endpointId === MODEL_SERVER_ENDPOINT_ID;
	const saved = onServer
		? null
		: (resolver.endpoints().find((endpoint) => endpoint.id === target.endpointId) ?? null);
	const shellEnvVars = saved ? resolver.shellEnvVars() : {};
	return {
		onServer,
		endpoint: onServer ? modelServerEndpoint(`http://${MODEL_SERVER_LOOPBACK_HOST}`) : saved,
		shellEnvVars,
		key: saved ? resolveEndpointApiKey(saved, shellEnvVars) : undefined,
	};
}

function servedDetail(models: readonly EndpointModel[]): string {
	if (models.length === 0) return 'it serves no models';
	const shown = models.slice(0, SERVED_MODELS_SHOWN).map((model) => model.id);
	const more = models.length - shown.length;
	return `it serves ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * Look an agent's Run on target up and make sure its source can serve the
 * model: the step every launch takes before it is planned. `none` for an agent
 * on its provider's model, which costs one parse and reads no store.
 */
export async function prepareAgentRunOn(
	request: AgentRunOnRequest
): Promise<AgentRunOnPreparation> {
	const remote = request.remote ?? null;
	const parsed = parseRunOnTarget(request.target);
	if (!parsed.ok) {
		// The resolver words a malformed target; it is refused, never read as
		// Provider.
		const refusal = resolveRunOnLaunch({
			toolType: request.toolType,
			target: request.target as RunOnTarget,
		});
		if (refusal.kind === 'refused') return refusal;
		throw new Error('A malformed Run on target was not refused.');
	}
	if (parsed.target.type === 'provider') return { kind: 'none' };
	const target = parsed.target;
	const resolver = requireDeps();
	const { onServer, endpoint: known, shellEnvVars, key } = lookUpSource(resolver, target);

	// Everything that can be refused without touching the network.
	const checked = resolveRunOnLaunch({
		toolType: request.toolType,
		target,
		endpoint: known,
		key,
		userEnvVars: request.userEnvVars,
		remote,
	});
	if (checked.kind === 'refused') return checked;
	if (checked.kind !== 'inject' || !known) {
		// A source target is injected or refused. Anything else is a bug, and it
		// must not read as "runs on the provider".
		throw new Error('A Run on source target resolved to neither a launch nor a refusal.');
	}

	const ready = (endpoint: LocalModelEndpoint, sourceKey?: string): AgentRunOnPreparation => ({
		kind: 'ready',
		runOn: { toolType: request.toolType, target, endpoint, key: sourceKey },
		model: target.model,
		label: runOnTargetLabel(target, [endpoint]),
	});

	// An agent that sets the base URL itself is not sent to the source, so its
	// launch does not depend on the source being up, and starting the model
	// server for it would load a model nothing asks for.
	const support = agentRunOnSupport(request.toolType);
	const routesItself =
		support.supported &&
		support.baseUrlEnvVar !== undefined &&
		checked.userOverrides.includes(support.baseUrlEnvVar);
	if (routesItself) return ready(known, key);

	if (onServer) {
		const server = await resolver.modelServer(target.model);
		if (!server.ok) return runOnUnavailable('run-on-server-failed', target, known, server.error);
		return ready(modelServerEndpoint(server.baseUrl), server.key);
	}

	let models: EndpointModel[];
	try {
		models = await (resolver.listModels ?? listEndpointModels)(known, { shellEnvVars });
	} catch (error) {
		if (!isLocalModelEndpointError(error)) throw error;
		return runOnUnavailable('run-on-source-unreachable', target, known, error.message);
	}
	if (!models.some((model) => model.id === target.model)) {
		return runOnUnavailable('run-on-model-not-served', target, known, servedDetail(models));
	}
	return ready(known, key);
}

/** A source, ready to be sent one request: its record (for its address) and its key. */
export type SourceCallTarget =
	| { ok: true; endpoint: LocalModelEndpoint; key?: string }
	| {
			ok: false;
			/**
			 * `missing`: no such source is configured. `disabled`: it is switched
			 * off. `server-failed`: the Maestro model server could not serve the
			 * model, and `detail` is what it said.
			 */
			reason: 'missing' | 'disabled' | 'server-failed';
			endpoint: LocalModelEndpoint | null;
			detail?: string;
	  };

/**
 * Where one request for a source target goes right now. For a caller that sends
 * the source a request ITSELF (the token proxy's background routing). A launch
 * goes through {@link prepareAgentRunOn}, which also applies the harness's
 * recipe.
 *
 * The Maestro model server is started and the model loaded when needed, as for
 * a launch. A saved source is not asked what it serves: the request is about to
 * be sent, and the source's own answer to it is the check. The caller words the
 * refusal, and must not send the request anywhere else.
 */
export async function resolveSourceCallTarget(
	target: RunOnSourceTarget
): Promise<SourceCallTarget> {
	const resolver = requireDeps();
	const { onServer, endpoint, key } = lookUpSource(resolver, target);
	if (!endpoint) return { ok: false, reason: 'missing', endpoint: null };
	if (!endpoint.enabled) return { ok: false, reason: 'disabled', endpoint };
	if (!onServer) return { ok: true, endpoint, key };
	const server = await resolver.modelServer(target.model);
	if (!server.ok) return { ok: false, reason: 'server-failed', endpoint, detail: server.error };
	return { ok: true, endpoint: modelServerEndpoint(server.baseUrl), key: server.key };
}

export interface LaunchRunOnRequest extends Omit<AgentRunOnRequest, 'remote'> {
	/** The agent's SSH setting, and where to look its remote up: what the plan is given. */
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	sshStore?: SshRemoteSettingsStore;
}

/**
 * {@link prepareAgentRunOn} for a launch that is about to be planned, from the
 * SSH inputs the plan itself takes. An agent on its provider's model costs one
 * parse: no store is read, the SSH remote included. An SSH remote that cannot
 * be resolved answers `none`, because `buildAgentLaunchPlan` refuses that
 * launch with the reason, and nothing should be looked up or started for it.
 * The caller MUST hand the result to the plan for exactly that reason.
 */
export async function prepareLaunchRunOn(
	request: LaunchRunOnRequest
): Promise<AgentRunOnPreparation> {
	if (!storedRunOnNamesSource(request.target)) return { kind: 'none' };
	const sshTarget = resolveSshLaunchTarget(request.sshStore, request.sshRemoteConfig);
	if (sshTarget.kind === 'unresolved') return { kind: 'none' };
	return prepareAgentRunOn({
		toolType: request.toolType,
		target: request.target,
		userEnvVars: request.userEnvVars,
		remote: sshTarget.kind === 'remote' ? { name: sshTarget.remote.name } : null,
	});
}

export interface SpawnRunOnInput {
	/** The Maestro agent whose stored target applies. */
	agentId: string;
	/** That agent's provider, e.g. `claude-code`. */
	toolType: string;
	/**
	 * The provider's definition: its model flag carries the target's model, its
	 * batch subcommand places the recipe's own arguments, and its default
	 * variables are what a recipe's merge builds on when the agent sets none.
	 */
	agent:
		| Pick<LaunchPlanAgent, 'modelArgs' | 'batchModePrefix' | 'defaultEnvVars'>
		| null
		| undefined;
	/** The arguments the spawn was about to use. */
	args: string[];
	/** The agent's effective custom vars; a recipe variable set here wins. */
	customEnvVars?: Record<string, string>;
	/** The SSH remote the process runs on, when it runs on one. */
	remote?: { name: string } | null;
}

export type SpawnRunOnResult =
	| {
			ok: true;
			args: string[];
			customEnvVars: Record<string, string> | undefined;
			/** What was applied, or null when the agent runs on its provider's model. */
			runOn: LaunchPlanRunOn | null;
	  }
	| { ok: false; error: string };

/**
 * Apply an agent's Run on target to a spawn that does not build a launch plan
 * (a Group Chat participant, a cross-agent consult). The same steps the
 * plan-based paths take, in one call so a new spawn site cannot do half of
 * them: read the agent's stored target, make sure its source can serve the
 * model, and put the recipe's variables, root arguments and model on the
 * spawn. A target that cannot run comes back as an error the caller must refuse
 * the spawn with; it never falls back to the provider's model.
 *
 * When `runOn` comes back set, the caller must NOT apply the agent's gateway
 * (`applyAgentGatewayToSpawn`): a Run on target takes its place.
 */
export async function applyAgentRunOnToSpawn(input: SpawnRunOnInput): Promise<SpawnRunOnResult> {
	const unchanged: SpawnRunOnResult = {
		ok: true,
		args: input.args,
		customEnvVars: input.customEnvVars,
		runOn: null,
	};
	const remote = input.remote ?? null;
	const prepared = await prepareAgentRunOn({
		toolType: input.toolType,
		target: storedAgentRunOn(input.agentId),
		userEnvVars: input.customEnvVars,
		remote,
	});
	if (prepared.kind === 'none') return unchanged;
	if (prepared.kind === 'refused') return { ok: false, error: prepared.message };

	const resolved = resolveRunOnLaunch({
		...prepared.runOn,
		userEnvVars: input.customEnvVars,
		remote,
	});
	if (resolved.kind === 'refused') return { ok: false, error: resolved.message };
	if (resolved.kind !== 'inject') {
		// As in prepareAgentRunOn: a prepared source target never resolves to
		// nothing, and must not be spawned as if it had.
		throw new Error('A prepared Run on target resolved to neither a launch nor a refusal.');
	}

	const applied = applyRunOnToLaunch({
		agent: input.agent,
		toolType: input.toolType,
		args: input.args,
		runOn: resolved,
		gatewayUrl: storedGatewayUrl(input.agentId),
	});
	if (!applied.ok) return { ok: false, error: applied.error };
	const customEnvVars = { ...(input.customEnvVars ?? {}), ...resolved.envVars };
	// The spawn puts these over the provider's defaults, so a merged variable
	// (OpenCode's inline config) is built here from the default it will cover.
	applyEnvVarMerges(customEnvVars, resolved.envVarMerges, input.agent?.defaultEnvVars);
	return {
		ok: true,
		args: applied.args,
		customEnvVars,
		runOn: applied.runOn,
	};
}

function storedGatewayUrl(agentId: string): string | undefined {
	const url = storedAgentRecord(agentId)?.gatewayUrl;
	return typeof url === 'string' ? url : undefined;
}

/**
 * Say where a launch's model runs, and that its gateway was passed over when it
 * has one. One wording for every surface in this process. Names only: the
 * variables' values include the source's key.
 */
export function logRunOnLaunch(
	logContext: string,
	launch: { sessionId: string; toolType: string },
	runOn: LaunchPlanRunOn
): void {
	logger.info(`Running ${launch.toolType} on ${runOn.model} (Run on)`, logContext, {
		sessionId: launch.sessionId,
		model: runOn.model,
		contextTokens: runOn.contextTokens,
		envVars: runOn.envVarNames,
		userOverrides: runOn.userOverrides,
		clearedEnvVars: runOn.clearedEnvVars,
	});
	if (runOn.skippedGatewayUrl) {
		logger.info(
			`Skipped the Local Models gateway for ${launch.toolType}: the agent runs on ${runOn.model}, and the gateway routes to its provider`,
			logContext,
			{ sessionId: launch.sessionId, gatewayUrl: runOn.skippedGatewayUrl }
		);
	}
}

/** Forget the stores, so each test starts from a process that was never configured. */
export function resetAgentRunOnForTests(): void {
	deps = null;
}
