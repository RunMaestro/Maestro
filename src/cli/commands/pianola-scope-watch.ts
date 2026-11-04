/** One desktop-supervised scope worker; never one child per historical chat. */
import { MaestroClient, CommandTimeoutError } from '../services/maestro-client';
import * as path from 'path';
import { getConfigDirectory } from '../services/storage';
import { PIANOLA_DECISIONS_FILENAME } from '../../shared/pianola/storage';
import { PianolaScopeFiles } from './pianola-scope-files';
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
import {
	isPianolaScopeId,
	pianolaOwnerSelectionState,
	type PianolaAgentGroupSelection,
} from '../../shared/pianola/pianola-scope';
import {
	runPianolaScopeCycle,
	PianolaCensusError,
	type PianolaScopeCycleDeps,
	type PianolaScopeDeliveryResult,
	type PianolaScopeDeliveryGuard,
	type PianolaScopeSnapshot,
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
	client: Pick<MaestroClient, 'sendCommand'>,
	files?: PianolaScopeFiles
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
			writeScopeCheckpoint: (checkpoint, durable) => {
				if (!files) return writePianolaScopeCheckpoint(checkpoint, durable);
				files.ownWrite(
					path.join(getConfigDirectory(), `maestro-pianola-scope-${checkpoint.scopeId}.json`),
					(receipt) => writePianolaScopeCheckpoint(checkpoint, durable, receipt)
				);
			},
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
						currentTurnInterest: 'pianola',
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
			recordDecision: (record) => {
				if (!files) return appendPianolaDecision(record);
				files.ownWrite(path.join(getConfigDirectory(), PIANOLA_DECISIONS_FILENAME), (receipt) =>
					appendPianolaDecision(record, receipt)
				);
			},
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

/** A single full-resync bit bounds any burst, including unknown membership/overflow.
 * Signals carry no authority: every drain still reads a real native census.
 */
export class PianolaScopeWakeups {
	private dirtyAt: number | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private wake: (() => void) | undefined;
	private stopped = false;
	private unselected = new Set<string>();
	private busyOwners = new Set<string>();
	private membershipGeneration = 0;
	invalidate = (): void => {
		this.membershipGeneration++;
		this.unselected.clear();
		this.busyOwners.clear();
		this.signal();
	};
	get generation(): number {
		return this.membershipGeneration;
	}
	setMembership(
		snapshot: PianolaScopeSnapshot,
		selection: PianolaAgentGroupSelection,
		generation: number
	): void {
		if (generation !== this.membershipGeneration) return;
		const owners = new Map(snapshot.owners.map((owner) => [owner.id, owner]));
		const unselected = new Set<string>();
		if (!snapshot.complete || owners.size !== snapshot.owners.length) {
			this.unselected.clear();
			this.busyOwners.clear();
			return;
		}
		const selected = new Set<string>();
		for (const owner of snapshot.owners) {
			const state = pianolaOwnerSelectionState(selection, owner, owners);
			if (state === 'unselected') unselected.add(owner.id);
			if (state === 'selected') selected.add(owner.id);
		}
		this.unselected = unselected;
		// Busy streams get one census per five seconds, independent of chunk frequency.
		// Deadlines and process/owner events retain their own earlier wakeup.
		this.busyOwners = new Set(
			snapshot.tabs
				.filter((tab) => tab.busy === true && selected.has(tab.agentId))
				.map((tab) => tab.agentId)
		);
		for (const tab of snapshot.tabs) if (tab.busy !== true) this.busyOwners.delete(tab.agentId);
	}
	signal = (): void => {
		if (this.stopped) return;
		this.dirtyAt = Math.min(this.dirtyAt ?? Infinity, Date.now() + 50);
		this.wake?.();
	};
	onFrame = (frame: Record<string, unknown>): void => {
		if (frame.type === 'bridge.event') {
			if (frame.channel === 'sessions:transcriptCommitted') {
				const cursor = Array.isArray(frame.args) ? frame.args[0] : undefined;
				const agentId =
					cursor && typeof cursor === 'object'
						? (cursor as { agentId?: unknown }).agentId
						: undefined;
				if (typeof agentId === 'string' && this.unselected.has(agentId)) return;
				if (typeof agentId === 'string' && this.busyOwners.has(agentId)) {
					if (this.stopped) return;
					this.dirtyAt = Math.min(this.dirtyAt ?? Infinity, Date.now() + 5000);
					this.wake?.();
					return;
				}
				this.signal();
				return;
			}
			if (
				[
					'sessions:transcriptCommitted',
					'sessions:lifecycleSync',
					'settings:externalChange',
					'process:exit',
					'process:command-exit',
					'agentRun:updated',
				].includes(String(frame.channel))
			)
				this.invalidate();
		} else if (
			[
				'connected',
				'session_state_change',
				'session_added',
				'session_removed',
				'tabs_changed',
			].includes(String(frame.type))
		)
			this.invalidate();
	};
	/** Consume before the cycle so events arriving during awaits survive it. */
	consume(): void {
		this.dirtyAt = undefined;
	}
	async wait(deadline: number): Promise<void> {
		while (!this.stopped) {
			const due = Math.min(deadline, this.dirtyAt ?? Infinity);
			if (due <= Date.now()) return;
			await new Promise<void>((resolve) => {
				this.wake = () => {
					clearTimeout(this.timer);
					this.timer = undefined;
					this.wake = undefined;
					resolve();
				};
				this.timer = setTimeout(this.wake, due - Date.now());
			});
		}
	}
	dispose(): void {
		this.stopped = true;
		this.wake?.();
		clearTimeout(this.timer);
		this.dirtyAt = undefined;
	}
}

export async function pianolaWatchScope(
	scopeId: string,
	options: PianolaScopeWatchOptions
): Promise<void> {
	ensurePianolaEnabled(options.json);
	if (!isPianolaScopeId(scopeId)) throw new Error('Invalid Pianola scope ID');
	const wakeups = new PianolaScopeWakeups();
	const files = new PianolaScopeFiles(scopeId, wakeups.invalidate);
	const client = new MaestroClient({ onFrame: wakeups.onFrame, onClose: wakeups.invalidate });
	const sweep = new Set<string>();
	let stopped = false;
	const onSignal = () => {
		stopped = true;
		wakeups.dispose();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	try {
		await client.connect();
		files.refresh();
		const deps = createPianolaScopeWorkerDeps(client, files);
		while (!stopped && pianolaEnabledNow()) {
			files.refresh();
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
			if (sweep.size === 0) wakeups.consume();
			let nextDueAt = Date.now() + 20000;
			let moreWork = false;
			try {
				const generation = wakeups.generation;
				const observed: { census?: PianolaScopeSnapshot } = {};
				const readSnapshot = deps.readSnapshot;
				const result = await runPianolaScopeCycle(
					scopeId,
					{
						...deps,
						readSnapshot: async () => {
							const snapshot = await readSnapshot();
							observed.census = snapshot;
							return snapshot;
						},
					},
					{
						dryRun: !!options.dryRun,
						maxTabs: 20,
						sweep,
						shouldStop: () => stopped || !pianolaEnabledNow(),
					}
				);
				if (observed.census) wakeups.setMembership(observed.census, target.selection, generation);
				moreWork = result.moreWork === true;
				nextDueAt = Math.min(nextDueAt, result.nextDueAt ?? Infinity);
				if (options.json) console.log(JSON.stringify({ scopeId, ...result }));
				else for (const issue of result.issues) console.error(`[pianola] ${scopeId}: ${issue}`);
			} catch (error) {
				if (!(error instanceof PianolaCensusError) || options.once) throw error;
				console.error(`[pianola] ${scopeId}: ${error.message}`);
			}
			if (options.once || stopped) break;
			if (!moreWork) sweep.clear();
			await wakeups.wait(moreWork ? Date.now() + 50 : nextDueAt);
		}
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		wakeups.dispose();
		files.dispose();
		client.disconnect();
	}
}
