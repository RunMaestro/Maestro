/** One desktop-supervised scope worker; never one child per historical chat. */
import { MaestroClient, CommandTimeoutError } from '../services/maestro-client';
import { ConnectionClosedError } from '../../shared/maestro-lib/client/bridge-connection';
import { MaestroNotRunningError } from '../services/maestro-not-running';
import {
	readPianolaSupervisorTargets,
	readPianolaScopeCheckpoint,
	writePianolaScopeCheckpoint,
	readPianolaDecisions,
	readPianolaRules,
	appendPianolaDecision,
	getPianolaProfile,
} from '../services/pianola-store';
import { generateUUID } from '../../shared/uuid';
import { isPianolaScopeId } from '../../shared/pianola/pianola-scope';
import {
	runPianolaScopeCycle,
	PianolaCensusError,
	type PianolaScopeCycleDeps,
	type PianolaScopeDeliveryResult,
	type PianolaScopeDeliveryGuard,
} from '../../shared/pianola/pianola-scope-cycle';
import type { WatchTarget } from '../../shared/pianola/pianola-watcher';
import { pausePianolaScopeDecisions } from '../../shared/pianola/pianola-decision-lifecycle';
import {
	composeCurrentTurn,
	currentTurnMessages,
	sameCurrentTurnCursor,
	type CurrentTurnRead,
} from '../../shared/currentTurn';
import {
	ensurePianolaEnabled,
	pianolaEnabledNow,
	readPianolaScopeSnapshot,
	buildNotifyToastCommand,
	buildPianolaHandoffPrompt,
} from './pianola';

export interface PianolaScopeWatchOptions {
	once?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

/** Production composition also exposed for isolated transport/store fixtures. */
export function createPianolaScopeWorkerDeps(
	client: Pick<MaestroClient, 'sendCommand'>
): PianolaScopeCycleDeps {
	const turns = new Map<string, CurrentTurnRead>();
	const deliver = async (
		target: WatchTarget,
		answer: string,
		guard: PianolaScopeDeliveryGuard,
		judgment = false
	): Promise<PianolaScopeDeliveryResult> => {
		if (!pianolaEnabledNow()) return { status: 'rejected', error: 'Pianola disabled' };
		try {
			const result = await client.sendCommand<PianolaScopeDeliveryResult>(
				{
					type: 'pianola_scope_reply',
					sessionId: target.agentId,
					tabId: target.tabId,
					answer,
					guard,
					judgment,
				},
				'pianola_scope_reply_result'
			);
			if (
				result.status === 'accepted' ||
				result.status === 'rejected' ||
				result.status === 'unknown'
			)
				return result;
			return { status: 'unknown', error: 'Missing native scope receipt' };
		} catch (error) {
			// Timeout/disconnect cannot establish that the recipient did not accept.
			return {
				status: 'unknown',
				error: error instanceof Error ? error.message : 'Scope delivery failed',
			};
		}
	};
	return {
		store: {
			readSupervisorTargets: readPianolaSupervisorTargets,
			readScopeCheckpoint: readPianolaScopeCheckpoint,
			writeScopeCheckpoint: writePianolaScopeCheckpoint,
			readDecisions: readPianolaDecisions,
		},
		readSnapshot: async () => {
			try {
				if (client instanceof MaestroClient && !client.isOpen) await client.connect();
				return await readPianolaScopeSnapshot(client);
			} catch (error) {
				if (
					error instanceof CommandTimeoutError ||
					error instanceof ConnectionClosedError ||
					error instanceof MaestroNotRunningError ||
					(error instanceof Error && error.message === 'Not connected to Maestro')
				)
					throw new PianolaCensusError(error.message);
				throw error;
			}
		},
		readTranscript: async (target, expected) => {
			if (!expected || expected.agentId !== target.agentId || expected.tabId !== target.tabId)
				throw new Error('Native current-turn cursor required');
			const key = JSON.stringify([target.agentId, target.tabId]);
			const base = turns.get(key);
			if (base && sameCurrentTurnCursor(base.cursor, expected))
				return {
					agentId: target.agentId,
					tabId: target.tabId,
					messages: currentTurnMessages(base),
					currentTurn: base,
				};
			const fetchTurn = async (delta: boolean) => {
				const response = await client.sendCommand<{
					success?: boolean;
					agentId?: string;
					tabId?: string;
					currentTurn?: CurrentTurnRead;
				}>(
					{
						type: 'get_session_history',
						tabId: target.tabId,
						currentTurn: true,
						expectedCursor: expected,
						...(delta && base ? { deltaBase: base.cursor } : {}),
					},
					'session_history_result'
				);
				if (
					response.success !== true ||
					response.agentId !== target.agentId ||
					response.tabId !== target.tabId ||
					!response.currentTurn ||
					!sameCurrentTurnCursor(response.currentTurn.cursor, expected)
				)
					throw new Error('Current-turn binding changed');
				return response.currentTurn;
			};
			try {
				let read = await fetchTurn(!!base);
				let turn: CurrentTurnRead;
				try {
					turn = composeCurrentTurn(read, base);
				} catch (error) {
					if (read.mode !== 'delta') throw error;
					read = await fetchTurn(false);
					turn = composeCurrentTurn(read);
				}
				turns.delete(key);
				turns.set(key, turn);
				// A reconnect or eviction costs a full refresh, never authority or a second watcher.
				while (turns.size > 20) turns.delete(turns.keys().next().value!);
				return {
					agentId: target.agentId,
					tabId: target.tabId,
					messages: currentTurnMessages(turn),
					currentTurn: turn,
				};
			} catch (error) {
				turns.delete(key);
				throw error;
			}
		},
		watch: {
			resolveProfile: (projectPath) => getPianolaProfile(projectPath).entry,
			readRules: readPianolaRules,
			recordDecision: appendPianolaDecision,
			now: () => new Date().toISOString(),
			genId: generateUUID,
			log: (line) => console.log(line),
			notify: async (event) => {
				if (!pianolaEnabledNow()) return;
				await client.sendCommand(buildNotifyToastCommand(event), 'notify_toast_result');
			},
		},
		dispatch: (target, answer, guard) => deliver(target, answer, guard),
		requestJudgment: (request, guard) =>
			deliver(request.target, buildPianolaHandoffPrompt(request, guard.decisionId), guard, true),
	};
}

export async function pianolaWatchScope(
	scopeId: string,
	options: PianolaScopeWatchOptions
): Promise<void> {
	ensurePianolaEnabled(options.json);
	if (!isPianolaScopeId(scopeId)) throw new Error('Invalid Pianola scope ID');
	const client = new MaestroClient();
	let stopped = false;
	let wake: (() => void) | undefined;
	const onSignal = () => {
		stopped = true;
		wake?.();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	try {
		await client.connect();
		const deps = createPianolaScopeWorkerDeps(client);
		while (!stopped && pianolaEnabledNow()) {
			const target = readPianolaSupervisorTargets().find(
				(candidate) => candidate.id === scopeId && candidate.kind === 'watch-scope'
			);
			if (!target?.enabled) {
				pausePianolaScopeDecisions(
					scopeId,
					{ readDecisions: readPianolaDecisions, appendDecision: appendPianolaDecision },
					new Date().toISOString()
				);
				// Disabling baselines on resume; an abrupt crash keeps its durable cursor.
				const checkpoint = readPianolaScopeCheckpoint(scopeId);
				if (checkpoint) {
					checkpoint.status = 'suspended';
					writePianolaScopeCheckpoint(checkpoint);
				}
				break;
			}
			if (target.selection?.mode !== 'agents-and-groups')
				throw new Error('Legacy scope requires explicit agent/group selection');
			try {
				const result = await runPianolaScopeCycle(scopeId, deps, {
					dryRun: !!options.dryRun,
					maxTabs: 20,
					shouldStop: () => stopped || !pianolaEnabledNow(),
				});
				if (options.json) console.log(JSON.stringify({ scopeId, ...result }));
				else for (const issue of result.issues) console.error(`[pianola] ${scopeId}: ${issue}`);
			} catch (error) {
				if (!(error instanceof PianolaCensusError) || options.once) throw error;
				console.error(`[pianola] ${scopeId}: ${error.message}`);
			}
			if (options.once || stopped) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(
					() => {
						wake = undefined;
						resolve();
					},
					(target.intervalSeconds ?? 5) * 1000
				);
				wake = () => {
					clearTimeout(timer);
					wake = undefined;
					resolve();
				};
			});
		}
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		client.disconnect();
	}
}
