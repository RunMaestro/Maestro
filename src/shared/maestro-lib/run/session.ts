// src/shared/maestro-lib/run/session.ts

import type { QuerySource } from '../../querySource';
import { buildAgentArgs } from '../launch/agent-args';
import { buildAgentLaunchPlan } from '../launch/launch-plan';
import { checkBinaryExists, checkCustomPath } from '../launch/path-prober';
import { getAgentCapabilities } from '../providers/capabilities';
import { getAgentDefinition } from '../providers/definitions';
import { turnProcessSpecFromPlan, type TurnProcessSpec } from './start-turn';

/**
 * One turn of a provider session: a new conversation, or the next message in
 * one that already exists.
 */
export interface SessionTurnRequest {
	/** The provider to run, e.g. `claude-code`. */
	agentId: string;
	/** The directory the agent works in. */
	cwd: string;
	prompt: string;
	/**
	 * The session to continue, as an earlier turn returned it. A provider keeps
	 * the conversation; the id is all that has to be carried between turns.
	 */
	resumeSessionId?: string;
	model?: string;
	/** Plan mode: the agent may read but not change anything. */
	readOnly?: boolean;
	/**
	 * Where the provider's binary is. When omitted it is looked up on PATH and
	 * in the provider's known install locations.
	 */
	command?: string;
	/** Environment variables for this turn, on top of the provider's defaults. */
	envVars?: Record<string, string>;
	/** Who asked for the turn. Stamped into the agent's environment. */
	querySource?: QuerySource;
}

export type SessionTurnPlan =
	| { ok: true; spec: TurnProcessSpec; resuming: boolean }
	| {
			ok: false;
			reason: 'unknown-agent' | 'no-batch-mode' | 'no-resume' | 'not-installed' | 'launch';
			error: string;
	  };

/**
 * Plan one turn with nothing but the library: look the provider up, find its
 * binary, build its batch arguments (resume included), and plan the launch.
 *
 * This is the whole path from "run this agent on this prompt" to a process
 * spec `startTurn` can start, for a program that has no desktop app around it.
 * Local only: a remote turn needs an SSH remote, which belongs to a host that
 * stores one.
 */
export async function planSessionTurn(request: SessionTurnRequest): Promise<SessionTurnPlan> {
	const definition = getAgentDefinition(request.agentId);
	if (!definition) {
		return {
			ok: false,
			reason: 'unknown-agent',
			error: `Unknown agent "${request.agentId}"`,
		};
	}

	const capabilities = getAgentCapabilities(request.agentId);
	if (!capabilities.supportsBatchMode) {
		return {
			ok: false,
			reason: 'no-batch-mode',
			error: `${definition.name} cannot run a single turn without a terminal`,
		};
	}

	const resuming = Boolean(request.resumeSessionId);
	if (resuming && (!capabilities.supportsResume || !definition.resumeArgs)) {
		return {
			ok: false,
			reason: 'no-resume',
			error: `${definition.name} cannot resume a session`,
		};
	}

	const detected = request.command
		? await checkCustomPath(request.command)
		: await checkBinaryExists(definition.binaryName);
	if (!detected.exists || !detected.path) {
		return {
			ok: false,
			reason: 'not-installed',
			error: request.command
				? `${definition.name} was not found at ${request.command}`
				: `${definition.name} (${definition.binaryName}) was not found on this machine`,
		};
	}

	const agent = { ...definition, available: true, path: detected.path, capabilities };
	const args = buildAgentArgs(agent, {
		baseArgs: definition.args,
		prompt: request.prompt,
		cwd: request.cwd,
		modelId: request.model,
		agentSessionId: request.resumeSessionId,
		permissionMode: request.readOnly ? 'readonly' : 'full',
		// No terminal is attached, so the agent must run in batch mode even when
		// the prompt is empty.
		forceBatchMode: true,
	});

	const planned = buildAgentLaunchPlan({
		// A program run from a shell: the shell's exported values stand, as they
		// do for `maestro-cli`.
		surface: 'cli',
		agent,
		command: detected.path,
		args,
		cwd: request.cwd,
		prompt: request.prompt,
		readOnlyMode: request.readOnly,
		sessionCustomEnvVars: request.envVars,
		isResuming: resuming,
		querySource: request.querySource,
	});
	if (!planned.ok) {
		return { ok: false, reason: 'launch', error: planned.error };
	}
	const plan = planned.plan;
	if (plan.env === undefined) {
		return { ok: false, reason: 'launch', error: 'A session turn runs on this machine only' };
	}

	return { ok: true, spec: turnProcessSpecFromPlan(plan), resuming };
}
