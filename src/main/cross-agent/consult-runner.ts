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

import { captureException } from '../utils/sentry';
import type { ProcessManager } from '../process-manager';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { spawnGroupChatAgent } from '../group-chat/spawnGroupChatAgent';
import { toSpawnGroupChatAgentConfig } from '../group-chat/spawn-config';
import { extractTextFromStreamJson } from '../group-chat/output-parser';
import { AGENT_LIVENESS_EVENTS } from '../utils/agent-liveness';
import type { ConsultRunner } from '../../shared/maestro-lib/agents/consult';
import type { AgentError } from '../../shared/types';

interface RunningConsult {
	/** The target's stream-json output so far. Each `data` event is a delta. */
	buffer: string;
	/** The user-visible host failure, preserved across a signal's null exit code. */
	error?: string;
	toolType: string;
	detach: () => void;
}

export interface NativeConsultAdmission {
	/** Positive host proof that the native spawn boundary was never crossed. */
	notStarted?(): void;
	beforeSpawn(): void;
	started(processId: string, pid?: number): void;
	ended?(processId: string): void;
}

export function createDesktopConsultRunner(
	processManager: ProcessManager,
	sshStore: SshRemoteSettingsStore | null,
	nativeAdmission?: NativeConsultAdmission
): ConsultRunner {
	const runs = new Map<string, RunningConsult>();

	return {
		async start(spawn, observer) {
			const sessionId = spawn.processId;
			const run: RunningConsult = { buffer: '', toolType: spawn.providerId, detach: () => {} };

			// Buffer the target's output; hand the text over once it exits. The ProcessManager flushes
			// the final delta BEFORE it emits 'exit', so by the time onExit fires the buffer is whole.
			const onData = (sid: string, data: string): void => {
				if (sid === sessionId) run.buffer += data;
			};
			// Any liveness signal for THIS consult restarts the silence budget. Separate from `onData`
			// because most of these events carry no text we want to buffer - they only prove the
			// target is still working (a claude-code consult emits `data` once, at the very end).
			const onLiveness = (sid: string): void => {
				if (sid === sessionId) observer.onActivity();
			};
			const onSessionId = (sid: string, agentSessionId: string): void => {
				if (sid === sessionId) observer.onSessionId(agentSessionId);
			};
			const onError = (sid: string, error: AgentError): void => {
				if (sid === sessionId && error.source === 'host-supervision') run.error ??= error.message;
			};
			const onExit = (sid: string, code: number): void => {
				if (sid !== sessionId) return;
				run.detach();
				runs.delete(sessionId);
				try {
					nativeAdmission?.ended?.(sessionId);
				} catch (error) {
					run.error ??= 'Native consult terminal admission failed';
					void captureException(error, {
						operation: 'crossAgent:endedJournal',
						processId: sessionId,
					});
				}
				observer.onEnd({
					exitCode: code,
					error: run.error,
					readText: () => extractTextFromStreamJson(run.buffer, spawn.providerId),
				});
			};

			run.detach = () => {
				processManager.off('data', onData);
				for (const evt of AGENT_LIVENESS_EVENTS) processManager.off(evt, onLiveness);
				processManager.off('exit', onExit);
				processManager.off('agent-error', onError);
				processManager.off('session-id', onSessionId);
			};

			processManager.on('data', onData);
			for (const evt of AGENT_LIVENESS_EVENTS) processManager.on(evt, onLiveness);
			processManager.on('exit', onExit);
			processManager.on('agent-error', onError);
			processManager.on('session-id', onSessionId);
			runs.set(sessionId, run);

			let spawnAttempted = false;
			try {
				const result = await spawnGroupChatAgent({
					...toSpawnGroupChatAgentConfig(spawn, { processManager, sshStore }),
					beforeSpawn: () => {
						nativeAdmission?.beforeSpawn();
						spawnAttempted = true;
					},
				});
				if (result.success) {
					// Admission persistence is not a spawn failure. Keep listeners and the
					// service's Stop/watchdog ownership after the native child exists.
					try {
						nativeAdmission?.started(sessionId, result.pid);
					} catch (error) {
						run.error ??= 'Native consult start admission failed';
						void captureException(error, {
							operation: 'crossAgent:startedJournal',
							processId: sessionId,
						});
					}
				}
				if (!result.success) {
					if (!spawnAttempted) nativeAdmission?.notStarted?.();
					run.detach();
					runs.delete(sessionId);
				}
				return result;
			} catch (err) {
				if (!spawnAttempted) nativeAdmission?.notStarted?.();
				run.detach();
				runs.delete(sessionId);
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
}
