/**
 * @file consult-runner.ts
 * @description The desktop's {@link ConsultRunner}: one consult process over the shared `ProcessManager`.
 *
 * The consult service (`src/shared/maestro-lib/agents/consult.ts`) owns what a consult IS: the
 * prompt, the budgets, the completion rule. This owns how the desktop runs one: attach the
 * `ProcessManager` listeners for the consult's process id, spawn through
 * `spawnGroupChatAgent` (SSH wrap, Claude spawn mode, Windows shell), buffer the stream-json
 * output, and report liveness, the provider session id and the end to the service.
 *
 * The emitter is shared app-wide, so every listener filters on this consult's process id, and
 * every listener is removed once the consult ends, is stopped, or fails to start.
 */

import type { ProcessManager } from '../process-manager';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { spawnGroupChatAgent } from '../group-chat/spawnGroupChatAgent';
import { toSpawnGroupChatAgentConfig } from '../group-chat/spawn-config';
import { extractTextFromStreamJson } from '../group-chat/output-parser';
import { AGENT_LIVENESS_EVENTS } from '../utils/agent-liveness';
import type { ConsultRunner } from '../../shared/maestro-lib/agents/consult';
import type { AgentError } from '../../shared/types';
import { beginGlobalWorktreeActivity } from '../git/worktreeActivity';
import { withWorktreeTurnActivity } from '../git/worktreeTurnActivity';
import { captureException } from '../utils/sentry';

interface RunningConsult {
	/** The target's stream-json output so far. Each `data` event is a delta. */
	buffer: string;
	/** The user-visible host failure, preserved across a signal's null exit code. */
	error?: string;
	toolType: string;
	detach: () => void;
}

export function createDesktopConsultRunner(
	processManager: ProcessManager,
	sshStore: SshRemoteSettingsStore | null
): ConsultRunner {
	const runs = new Map<string, RunningConsult>();

	const admitted: ConsultRunner = {
		async start(spawn, observer) {
			const sessionId = spawn.processId;
			if (runs.has(sessionId))
				throw new Error('Consult is already registered. Stop it before retrying.');
			const run: RunningConsult = { buffer: '', toolType: spawn.providerId, detach: () => {} };

			// Buffer the target's output; hand the text over once it exits. The ProcessManager flushes
			// the final delta BEFORE it emits 'exit', so by the time onExit fires the buffer is whole.
			const onData = (sid: string, data: string): void => {
				if (sid !== sessionId) return;
				withWorktreeTurnActivity(
					() => {
						run.buffer += data;
					},
					(error) => void captureException(error)
				);
			};
			// Any liveness signal for THIS consult restarts the silence budget. Separate from `onData`
			// because most of these events carry no text we want to buffer - they only prove the
			// target is still working (a claude-code consult emits `data` once, at the very end).
			const onLiveness = (sid: string): void => {
				if (sid !== sessionId) return;
				withWorktreeTurnActivity(
					() => observer.onActivity(),
					(error) => void captureException(error)
				);
			};
			const onSessionId = (sid: string, agentSessionId: string): void => {
				if (sid !== sessionId) return;
				withWorktreeTurnActivity(
					() => observer.onSessionId(agentSessionId),
					(error) => void captureException(error)
				);
			};
			const onError = (sid: string, error: AgentError): void => {
				if (sid !== sessionId) return;
				withWorktreeTurnActivity(
					() => {
						if (error.source === 'host-supervision') run.error ??= error.message;
					},
					(failure) => void captureException(failure)
				);
			};
			const onExit = (sid: string, code: number): void => {
				if (sid !== sessionId) return;
				// Events and deferred parsing outlive the start request's activity.
				// Each owns its callback scope; native close is tracked separately.
				withWorktreeTurnActivity(
					() => {
						run.detach();
						if (runs.get(sessionId) === run) runs.delete(sessionId);
						observer.onEnd({
							exitCode: code,
							error: run.error,
							readText: () =>
								withWorktreeTurnActivity(
									() => extractTextFromStreamJson(run.buffer, spawn.providerId),
									(error) => void captureException(error)
								),
						});
					},
					(error) => void captureException(error)
				);
			};

			const listeners = [
				{
					attach: () => processManager.on('data', onData),
					detach: () => processManager.off('data', onData),
				},
				...AGENT_LIVENESS_EVENTS.map((evt) => ({
					attach: () => processManager.on(evt, onLiveness),
					detach: () => processManager.off(evt, onLiveness),
				})),
				{
					attach: () => processManager.on('exit', onExit),
					detach: () => processManager.off('exit', onExit),
				},
				{
					attach: () => processManager.on('agent-error', onError),
					detach: () => processManager.off('agent-error', onError),
				},
				{
					attach: () => processManager.on('session-id', onSessionId),
					detach: () => processManager.off('session-id', onSessionId),
				},
			];
			const releaseListeners = beginGlobalWorktreeActivity();
			const pendingDetach: Array<() => void> = [];
			let registering = true;
			let detaching = false;
			run.detach = () => {
				// EventEmitter hooks can reenter while insertion/removal is in flight.
				// Keep the run reachable and retry after that operation settles.
				if (registering || detaching)
					throw new Error('Consult listeners are changing. Retry stop.');
				detaching = true;
				try {
					while (pendingDetach.length) {
						pendingDetach[0]();
						pendingDetach.shift();
					}
					releaseListeners();
				} finally {
					detaching = false;
				}
			};
			runs.set(sessionId, run);

			try {
				try {
					for (const listener of listeners) {
						// Insertion may retain the callback before throwing.
						pendingDetach.push(listener.detach);
						listener.attach();
					}
				} finally {
					registering = false;
				}
				const result = await spawnGroupChatAgent(
					toSpawnGroupChatAgentConfig(spawn, { processManager, sshStore })
				);
				if (!result.success) {
					run.detach();
					if (runs.get(sessionId) === run) runs.delete(sessionId);
				}
				return result;
			} catch (err) {
				run.detach();
				if (runs.get(sessionId) === run) runs.delete(sessionId);
				throw err;
			}
		},

		stop(processId) {
			const run = runs.get(processId);
			run?.detach();
			runs.delete(processId);
			try {
				processManager.kill(processId);
			} catch {
				// Process may already be gone - nothing to kill.
			}
			if (!run) return '';
			try {
				return extractTextFromStreamJson(run.buffer, run.toolType);
			} catch {
				// A stream truncated mid-object may not parse; the caller's error still lands.
				return '';
			}
		},
	};

	return {
		async start(spawn, observer) {
			// Own listener/config setup as well as the shared spawn helper. A stop
			// during async preparation cannot release this pending start's activity.
			const release = beginGlobalWorktreeActivity();
			try {
				return await admitted.start(spawn, observer);
			} finally {
				release();
			}
		},
		stop(processId) {
			// Refuse before detach, kill or their best-effort recovery. Native
			// process holds remain independent of this synchronous request scope.
			const release = beginGlobalWorktreeActivity();
			try {
				return admitted.stop(processId);
			} finally {
				release();
			}
		},
	};
}
