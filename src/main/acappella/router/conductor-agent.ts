/**
 * The Conductor as a real Maestro agent.
 *
 * The third Brain option, for people who want routing decided by something that
 * can actually reason about their projects rather than by a 1.7B classifier. It
 * is a normal batch agent run: the routing context plus the utterance go in, a
 * `RouteDecision` comes back through the same schema and the same validator as
 * every other Brain, so nothing downstream can tell which one answered.
 *
 * Two properties this file exists to hold:
 *
 * **It never blocks the floor.** A real agent can be mid-turn when the user
 * speaks, and an agent that takes ninety seconds to answer is not a router. So
 * there is exactly one request in flight, a hard deadline on it, and a second
 * one is refused with a spoken "the Conductor is busy" instead of being queued
 * behind something the user has already stopped caring about.
 *
 * **SSH is explicit.** `ProcessManager.spawn` does NOT wrap for SSH - callers
 * do, which is why {@link wrapSpawnWithSsh} is called here. A configured remote
 * that cannot be resolved throws rather than silently running the Conductor on
 * the local machine: the user opted into a remote, and a routing prompt carries
 * the names and paths of everything they have open.
 *
 * (`groomContext` is deliberately not reused. It is the same spawn-and-collect
 * shape, but its runs live in a registry that `cancelAllGroomingSessions()`
 * empties, and a Conductor decision cancelled because someone summarised a
 * context in another window would be an unexplainable misroute.)
 */

import { CONDUCTOR_AGENT_BRAIN_PROVIDER_ID } from '../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../shared/acappella/provider-errors';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../shared/acappella/providers';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import { generateUUID } from '../../../shared/uuid';
import type { AgentDetector } from '../../agents';
import { applyAgentConfigOverrides, buildAgentArgs } from '../../utils/agent-args';
import { logger } from '../../utils/logger';
import { wrapSpawnWithSsh } from '../../utils/ssh-spawn-wrapper';
import {
	buildConverseUserPrompt,
	buildRouteUserPrompt,
	converseSystemPrompt,
	limitSpokenReply,
	parseRouteDecision,
	routeSystemPrompt,
} from '../providers/brain-prompt';

const LOG_CONTEXT = 'ACappella';

/**
 * How long a routing turn may take before it is abandoned.
 *
 * Twenty seconds is already far outside what voice tolerates; it exists to bound
 * a hung process, not to be waited out. Anyone who finds this generous should
 * be running a local Brain.
 */
export const CONDUCTOR_AGENT_TIMEOUT_MS = 20_000;

/** The process manager surface this provider uses. Structural, so tests can fake it. */
export interface ConductorProcessManager {
	spawn(config: Record<string, unknown>): { pid: number; success?: boolean } | null;
	on(event: string, handler: (...args: any[]) => void): void;
	off(event: string, handler: (...args: any[]) => void): void;
	kill(sessionId: string): void;
}

/** The SSH remote settings adapter `wrapSpawnWithSsh` reads. */
type SshStore = Parameters<typeof wrapSpawnWithSsh>[2];

export interface ConductorAgentOptions {
	processManager: ConductorProcessManager;
	agentDetector: AgentDetector;
	/** Which agent runs the Conductor, and where. */
	agentType: string;
	cwd: string;
	/** SSH remote for the Conductor agent, when the user configured one. */
	sshRemoteConfig?: { enabled: boolean; remoteId: string | null; workingDirOverride?: string };
	/** Required when `sshRemoteConfig.enabled`. Its absence is a loud failure. */
	sshStore?: SshStore;
	agentConfigValues?: Record<string, any>;
	customEnvVars?: Record<string, string>;
	modelId?: string;
	timeoutMs?: number;
}

export class ConductorAgentBrain implements BrainProvider {
	readonly id = CONDUCTOR_AGENT_BRAIN_PROVIDER_ID;
	readonly label = 'Conductor agent';
	readonly tier = 'local' as const;

	private readonly options: ConductorAgentOptions;
	/**
	 * The one request in flight.
	 *
	 * A single slot rather than a queue: by the time a queued utterance reached
	 * the front, the conversation it belonged to would be over. Refusing is the
	 * behaviour a person can work with.
	 */
	private inFlight: Promise<string> | null = null;

	constructor(options: ConductorAgentOptions) {
		this.options = options;
	}

	/** True while a decision is being computed. Read by the HUD and by tests. */
	get isBusy(): boolean {
		return this.inFlight !== null;
	}

	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		const raw = await this.ask(
			[routeSystemPrompt(), '', buildRouteUserPrompt(input, context)].join('\n')
		);
		return parseRouteDecision(raw, context, input);
	}

	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		const raw = await this.ask(
			[converseSystemPrompt(), '', buildConverseUserPrompt(agentText, context)].join('\n')
		);
		return limitSpokenReply(raw, context.maxSentences);
	}

	// -- Internals -----------------------------------------------------------

	private async ask(prompt: string): Promise<string> {
		if (this.inFlight) {
			throw new VoiceProviderError('The Conductor is busy. Say that again in a moment.', {
				kind: 'busy',
				providerId: this.id,
			});
		}

		const run = this.run(prompt);
		this.inFlight = run;
		try {
			return await run;
		} finally {
			this.inFlight = null;
		}
	}

	private async run(prompt: string): Promise<string> {
		const { processManager, agentDetector, agentType, cwd } = this.options;

		const agent = await agentDetector.getAgent(agentType);
		if (!agent || !agent.available) {
			throw new VoiceProviderError(
				`The Conductor agent '${agentType}' is not available. Pick another Brain in Voice Setup.`,
				{ kind: 'unavailable', providerId: this.id }
			);
		}

		const baseArgs = buildAgentArgs(agent, {
			baseArgs: agent.args ?? [],
			prompt,
			cwd,
			// A router reads; it does not edit. Read-only also means no workspace
			// lock, so the Conductor can think while the agents it routes to work.
			readOnlyMode: true,
			modelId: this.options.modelId,
		});
		const resolved = applyAgentConfigOverrides(agent, baseArgs, {
			agentConfigValues: this.options.agentConfigValues ?? {},
			sessionCustomEnvVars: this.options.customEnvVars,
			readOnlyMode: true,
		});

		let spawnConfig: Record<string, unknown> = {
			command: agent.command,
			args: resolved.args,
			cwd,
			prompt,
			customEnvVars: resolved.effectiveCustomEnvVars,
			promptArgs: agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator,
		};

		const ssh = this.options.sshRemoteConfig;
		if (ssh?.enabled) {
			if (!this.options.sshStore) {
				// Loud, not local. The user asked for a remote; running here instead
				// would put their whole roster on a machine they did not choose.
				throw new VoiceProviderError(
					'The Conductor agent is configured for an SSH remote that could not be resolved.',
					{ kind: 'unavailable', providerId: this.id }
				);
			}
			const wrapped = await wrapSpawnWithSsh(
				{
					command: agent.command,
					args: resolved.args,
					cwd,
					prompt,
					customEnvVars: resolved.effectiveCustomEnvVars,
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
					agentBinaryName: agent.binaryName,
				},
				ssh,
				this.options.sshStore
			);
			if (!wrapped.sshRemoteUsed) {
				throw new VoiceProviderError(
					'The Conductor agent is configured for an SSH remote that could not be resolved.',
					{ kind: 'unavailable', providerId: this.id }
				);
			}
			spawnConfig = {
				command: wrapped.command,
				args: wrapped.args,
				cwd: wrapped.cwd,
				prompt: wrapped.prompt,
				customEnvVars: wrapped.customEnvVars,
				sshStdinScript: wrapped.sshStdinScript,
				sshRemoteCommand: wrapped.sshRemoteCommand,
				sshRemoteId: ssh.remoteId ?? undefined,
			};
		}

		const sessionId = `acappella-conductor-${generateUUID()}`;
		return this.collect(processManager, sessionId, {
			...spawnConfig,
			sessionId,
			toolType: agentType,
			readOnlyMode: true,
		});
	}

	/**
	 * Spawn and collect stdout until the process exits or the deadline passes.
	 *
	 * A timeout kills the process rather than only rejecting: an abandoned agent
	 * left running would still be holding a model, a token budget, and possibly a
	 * remote shell.
	 */
	private collect(
		processManager: ConductorProcessManager,
		sessionId: string,
		spawnConfig: Record<string, unknown>
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let output = '';
			let settled = false;

			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				processManager.off('data', onData);
				processManager.off('exit', onExit);
				fn();
			};

			const onData = (id: string, chunk: string): void => {
				if (id === sessionId && typeof chunk === 'string') output += chunk;
			};

			const onExit = (id: string): void => {
				if (id !== sessionId) return;
				finish(() => resolve(output));
			};

			const deadline = setTimeout(() => {
				finish(() => {
					try {
						processManager.kill(sessionId);
					} catch (error) {
						logger.warn(
							`Could not stop the Conductor agent: ${(error as Error).message}`,
							LOG_CONTEXT
						);
					}
					reject(
						new VoiceProviderError('The Conductor agent did not answer in time.', {
							kind: 'timeout',
							providerId: this.id,
						})
					);
				});
			}, this.options.timeoutMs ?? CONDUCTOR_AGENT_TIMEOUT_MS);
			deadline.unref?.();

			processManager.on('data', onData);
			processManager.on('exit', onExit);

			const result = processManager.spawn(spawnConfig);
			if (!result) {
				finish(() =>
					reject(
						new VoiceProviderError('The Conductor agent could not be started.', {
							kind: 'unavailable',
							providerId: this.id,
						})
					)
				);
			}
		});
	}
}

/** Sugar matching the rest of A Cappella's factories. */
export function createConductorAgentBrain(options: ConductorAgentOptions): ConductorAgentBrain {
	return new ConductorAgentBrain(options);
}
