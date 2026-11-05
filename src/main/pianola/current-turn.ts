import { createHash } from 'node:crypto';
import { generateUUID } from '../../shared/uuid';
import { canonicalJson } from '../../shared/canonicalJson';
import type { SessionTranscriptPatch } from '../../shared/sessionTranscript';
import type {
	CurrentTurnCursor,
	CurrentTurnMessage,
	CurrentTurnRead,
} from '../../shared/currentTurn';
import { resolveAgentRunProvider, type AgentRun } from '../../shared/agent-run';
import { nativeTabSession } from './pianola-queue-session';
import { extractQuestionCores } from '../../shared/pianola/pianola-awaiting-detector';

type State = {
	cursor: CurrentTurnCursor;
	enrollment?: CurrentTurnCursor;
	source: string;
	sequence: number;
	rowRevisions: Map<string, number>;
	/** Prose changes only; timestamps, metadata and order never confer freshness. */
	contentRevisions: Map<string, number>;
	contentSignatures: Map<string, string>;
	questionSignatures: Map<string, string[] | null>;
	rowBytes: Map<string, number>;
	rows: Map<string, CurrentTurnMessage>;
	order: string[];
	/** Last commit that changed an existing ordered prefix, including reorder-and-restore. */
	orderMutationRevision: number;
	bytes: number;
	reason?: string;
	freshBoundaryId?: string;
	pendingAnnouncement?: string;
};

/** One bounded current-turn projection per native tab; no fleet transcript hashing on census.
 * Eviction, renderer replacement and missing commits never reconstruct continuity from disk.
 * Completed turns remain until the next native turn or explicit eviction.
 */
export class NativeCurrentTurns {
	readonly generation = generateUUID();
	private revision = 0;
	private retainedBytes = 0;
	private states = new Map<string, State>();
	private hostCreations = new Map<
		string,
		{ agentId: string; tabId: string; createdAt: number; provider: string; durable: boolean }
	>();

	/** Only a successful host create may attest birth. The first authenticated
	 * owner commit consumes it, even when that commit cannot prove emptiness. */
	recordHostEmptyCreation(binding: {
		agentId: string;
		tabId: string;
		createdAt: number;
		provider: string;
	}): (durable: boolean) => void {
		if (!this.enabled) return () => {};
		const key = this.key(binding.agentId, binding.tabId);
		if (this.states.has(key) || this.hostCreations.has(key)) return () => {};
		const creation = { ...binding, durable: false };
		this.hostCreations.set(key, creation);
		while (this.hostCreations.size > this.limits.tabs)
			this.hostCreations.delete(this.hostCreations.keys().next().value!);
		return (durable) => {
			if (this.hostCreations.get(key) !== creation) return;
			if (durable) creation.durable = true;
			else this.hostCreations.delete(key);
		};
	}

	forgetHostEmptyCreation(agentId: string): void {
		for (const [key, binding] of this.hostCreations)
			if (binding.agentId === agentId) this.hostCreations.delete(key);
	}
	private observers = new Map<string, { expiresAt: number; client?: object }>();
	private observerClients = new WeakSet<object>();
	constructor(
		private limits = {
			tabs: 2048,
			messages: 8192,
			bytes: 2 * 1024 * 1024,
			totalBytes: 32 * 1024 * 1024,
		},
		private enabled = true
	) {}
	private key(agentId: string, tabId: string): string {
		return canonicalJson([agentId, tabId]);
	}

	/** Feature transitions discard continuity. A new native boundary is required on re-enable. */
	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		this.states.clear();
		this.hostCreations.clear();
		this.retainedBytes = 0;
	}

	/** Generic reads lease one tab for 30 seconds from the latest read. The latest
	 * client owns that lease; its disconnect releases it. Internal Pianola reads
	 * never lease: feature enablement alone owns their capture lifetime. */
	observe(
		agentId: string,
		tabId: string,
		client?: { once(event: 'close', listener: () => void): unknown }
	): void {
		this.expireObservers();
		const key = this.key(agentId, tabId);
		this.observers.delete(key);
		this.observers.set(key, { expiresAt: Date.now() + 30_000, client });
		if (client && !this.observerClients.has(client)) {
			this.observerClients.add(client);
			client.once('close', () => {
				for (const [key, interest] of this.observers) {
					if (interest.client === client) this.removeObserver(key);
				}
			});
		}
		while (this.observers.size > this.limits.tabs)
			this.removeObserver(this.observers.keys().next().value!);
	}

	private removeObserver(key: string): void {
		this.observers.delete(key);
		if (!this.enabled) {
			this.retainedBytes -= this.states.get(key)?.bytes ?? 0;
			this.states.delete(key);
		}
	}

	private expireObservers(): void {
		const now = Date.now();
		for (const [key, interest] of this.observers) {
			if (interest.expiresAt <= now) this.removeObserver(key);
		}
	}

	commit(patch: SessionTranscriptPatch): CurrentTurnCursor | undefined {
		if (!this.enabled) this.expireObservers();
		if (!this.enabled && !this.observers.size) return;
		if (!patch.tabId) return;
		const key = this.key(patch.sessionId, patch.tabId);
		if (!this.enabled && !this.observers.has(key)) return;
		const hostCreation = this.hostCreations.get(key);
		this.hostCreations.delete(key);
		const meta = patch.observation;
		if (!patch.tabId || patch.field !== 'logs' || !meta) return;
		if (
			!Number.isSafeInteger(meta.sequence) ||
			meta.sequence < 1 ||
			!Number.isSafeInteger(meta.createdAt) ||
			!meta.sourceGeneration ||
			!meta.provider
		)
			return;
		let state = this.states.get(key);
		const initial = !state;
		if (state && meta.sourceGeneration === state.source && meta.sequence <= state.sequence) return;
		const previousBytes = state?.bytes ?? 0;
		const replaced =
			!!state &&
			(state.source !== meta.sourceGeneration ||
				state.cursor.createdAt !== meta.createdAt ||
				state.cursor.provider !== meta.provider);
		if (!state || replaced) {
			state = {
				cursor: {
					generation: this.generation,
					sourceGeneration: meta.sourceGeneration,
					agentId: patch.sessionId,
					tabId: patch.tabId,
					createdAt: meta.createdAt,
					provider: meta.provider,
					agentSessionId: null,
					runId: null,
					turnId: null,
					revision: ++this.revision,
				},
				source: meta.sourceGeneration,
				sequence: meta.sequence - 1,
				rows: new Map(),
				rowRevisions: new Map(),
				contentRevisions: new Map(),
				contentSignatures: new Map(),
				questionSignatures: new Map(),
				rowBytes: new Map(),
				order: [],
				orderMutationRevision: 0,
				bytes: 0,
				reason: replaced ? 'renderer-or-binding-reset' : 'missing-native-boundary',
			};
			this.states.delete(key);
			this.states.set(key, state);
		}
		if (meta.sequence !== state.sequence + 1) state.reason = 'commit-gap';
		state.sequence = meta.sequence;
		state.cursor.revision = ++this.revision;
		if (meta.closed) state.reason = 'tab-closed-or-snoozed';
		if (patch.runtime && 'agentSessionId' in patch.runtime) {
			const id =
				typeof patch.runtime.agentSessionId === 'string' ? patch.runtime.agentSessionId : null;
			if (state.pendingAnnouncement && id === state.pendingAnnouncement)
				state.pendingAnnouncement = undefined;
			if (!state.pendingAnnouncement || id !== null) {
				if (state.cursor.agentSessionId && id !== state.cursor.agentSessionId)
					state.reason = 'provider-session-reset';
				state.cursor.agentSessionId = id;
			}
		} else if (!state.pendingAnnouncement && patch.clearRuntimeFields?.includes('agentSessionId')) {
			if (state.cursor.agentSessionId) state.reason = 'provider-session-reset';
			state.cursor.agentSessionId = null;
		}
		// A snapshot during a captured turn is a replacement, not proof that dropped risk never existed.
		if (patch.snapshot && (state.cursor.runId || state.enrollment))
			state.reason = 'transcript-reset';
		if (patch.removedIds.length && state.enrollment) state.reason = 'current-turn-trimmed';
		if (patch.removedIds.some((id) => state!.rows.has(id))) state.reason = 'current-turn-trimmed';
		if (patch.snapshot) {
			state.rows.clear();
			state.rowRevisions.clear();
			state.contentRevisions.clear();
			state.contentSignatures.clear();
			state.questionSignatures.clear();
			state.rowBytes.clear();
			state.order = [];
			state.bytes = 0;
		}
		for (const id of patch.removedIds) {
			const old = state.rows.get(id);
			if (old) state.bytes -= state.rowBytes.get(id)!;
			state.rows.delete(id);
			state.rowRevisions.delete(id);
			state.contentRevisions.delete(id);
			state.contentSignatures.delete(id);
			state.questionSignatures.delete(id);
			state.rowBytes.delete(id);
			state.order = state.order.filter((entry) => entry !== id);
		}
		for (const raw of patch.upserts) {
			const row = raw as Partial<CurrentTurnMessage>;
			if (
				typeof row.id !== 'string' ||
				typeof row.text !== 'string' ||
				typeof row.source !== 'string' ||
				!Number.isFinite(row.timestamp)
			) {
				state.reason = 'invalid-native-row';
				continue;
			}
			const value = structuredClone(row) as CurrentTurnMessage;
			const serialized = canonicalJson(value);
			if (
				serialized.includes('[tool output truncated,') ||
				serialized.includes('[tool output omitted:')
			)
				state.reason = 'native-tool-output-truncated';
			const serializedBytes = Buffer.byteLength(serialized);
			const old = state.rows.get(row.id);
			const proseChanged = !old || old.text !== value.text || old.source !== value.source;
			const cores =
				proseChanged &&
				serializedBytes <= this.limits.bytes &&
				['ai', 'stdout'].includes(value.source)
					? extractQuestionCores(value.text)
					: null;
			// Count retained question evidence against the same per-tab/fleet byte budgets.
			const questionCount = proseChanged
				? (cores?.length ?? 0)
				: (state.questionSignatures.get(row.id)?.length ?? 0);
			const bytes = serializedBytes + questionCount * 64;
			if (old && old.source !== value.source) state.reason = 'native-row-source-changed';
			if (!old && row.source === 'user' && (!patch.snapshot || !replaced))
				state.freshBoundaryId = row.id;
			if (old) state.bytes -= state.rowBytes.get(row.id)!;
			if (
				bytes + state.bytes > this.limits.bytes ||
				(!old && state.rows.size >= this.limits.messages)
			) {
				state.reason = 'current-turn-overflow';
				state.rows.clear();
				state.rowRevisions.clear();
				state.contentRevisions.clear();
				state.contentSignatures.clear();
				state.questionSignatures.clear();
				state.rowBytes.clear();
				state.order = [];
				state.bytes = 0;
				break;
			}
			if (proseChanged) {
				state.contentRevisions.set(row.id, state.cursor.revision);
				// Hash only changed, size-checked prose at the native commit boundary.
				state.contentSignatures.set(
					row.id,
					createHash('sha256').update(value.source).update('\0').update(value.text).digest('hex')
				);
				state.questionSignatures.set(
					row.id,
					cores?.map((core) => createHash('sha256').update(core).digest('hex')) ?? null
				);
			}
			state.rows.set(row.id, value);
			state.rowBytes.set(row.id, bytes);
			state.rowRevisions.set(row.id, state.cursor.revision);
			state.bytes += bytes;
		}
		if (patch.orderIds.length || patch.snapshot) {
			const ordered = new Set(patch.orderIds);
			if (state.order.some((id) => !ordered.has(id))) state.reason = 'current-turn-order-trimmed';
			const nextOrder = patch.orderIds.filter((id) => state!.rows.has(id));
			// Row revisions alone cannot see moves of unchanged rows. Prefix-preserving
			// appends compose across commits; any other order change fences older reads.
			if (state.order.some((id, position) => nextOrder[position] !== id))
				state.orderMutationRevision = state.cursor.revision;
			state.order = nextOrder;
		}
		if (state.order.length !== state.rows.size) state.reason = 'commit-order-gap';
		// Before spawn only retain the latest user boundary and its following output.
		// Once captured, a new human row invalidates the old turn until its own native spawn.
		let user = state.order.length - 1;
		while (user >= 0 && state.rows.get(state.order[user])?.source !== 'user') user--;
		if (user >= 0) {
			const boundary = state.order[user];
			if (!state.reason && state.cursor.turnId && boundary !== state.cursor.turnId)
				state.reason = 'new-user-boundary';
			if (!state.cursor.runId) {
				for (const id of state.order.slice(0, user)) {
					state.bytes -= state.rowBytes.get(id)!;
					state.rows.delete(id);
					state.rowRevisions.delete(id);
					state.contentRevisions.delete(id);
					state.contentSignatures.delete(id);
					state.questionSignatures.delete(id);
					state.rowBytes.delete(id);
				}
				state.order = state.order.slice(user);
			}
		}
		if (
			initial &&
			!replaced &&
			meta.sequence === 1 &&
			(meta.emptyCreation === true ||
				(hostCreation?.durable === true &&
					hostCreation.createdAt === meta.createdAt &&
					hostCreation.provider === meta.provider)) &&
			patch.snapshot &&
			!meta.closed &&
			!patch.upserts.length &&
			!patch.orderIds.length &&
			!patch.removedIds.length &&
			!state.cursor.agentSessionId &&
			patch.runtime?.state === 'idle' &&
			!patch.runtime?.pid &&
			!patch.runtime?.awaitingSessionId &&
			state.reason === 'missing-native-boundary'
		) {
			state.enrollment = { ...state.cursor };
		}
		if (
			state.reason &&
			!['missing-native-boundary', 'native-spawn-unbound', 'new-user-boundary'].includes(
				state.reason
			)
		)
			delete state.enrollment;
		this.retainedBytes += state.bytes - previousBytes;
		while (this.states.size > this.limits.tabs || this.retainedBytes > this.limits.totalBytes) {
			const first = this.states.keys().next().value!;
			this.retainedBytes -= this.states.get(first)!.bytes;
			this.states.delete(first);
		}
		return { ...state.cursor };
	}

	/** Native lifecycle evidence invalidates old reads even when ledger capture fails. */
	spawning(processSessionId: string): void {
		for (const [key, binding] of this.hostCreations)
			if (processSessionId === `${binding.agentId}-ai-${binding.tabId}`)
				this.hostCreations.delete(key);
		for (const state of this.states.values()) {
			if (`${state.cursor.agentId}-ai-${state.cursor.tabId}` !== processSessionId) continue;
			state.reason = 'native-spawn-unbound';
			state.cursor.revision = ++this.revision;
		}
	}

	announce(processSessionId: string, providerSessionId: string): void {
		if (!providerSessionId) return;
		for (const [key, binding] of this.hostCreations)
			if (processSessionId === `${binding.agentId}-ai-${binding.tabId}`)
				this.hostCreations.delete(key);
		for (const state of this.states.values()) {
			if (`${state.cursor.agentId}-ai-${state.cursor.tabId}` !== processSessionId) continue;
			if (state.cursor.agentSessionId === providerSessionId) continue;
			if (state.cursor.agentSessionId) {
				state.reason = 'provider-session-reset';
				delete state.enrollment;
			} else state.pendingAnnouncement = providerSessionId;
			state.cursor.agentSessionId = providerSessionId;
			state.cursor.revision = ++this.revision;
		}
	}

	begin(run: AgentRun, boundaryId?: string): void {
		const native = nativeTabSession(run);
		if (!native) return;
		this.hostCreations.delete(this.key(native.agentId, native.tabId));
		const state = this.states.get(this.key(native.agentId, native.tabId));
		if (!state) return;
		const boundary = boundaryId && state.rows.get(boundaryId);
		const valid =
			boundary &&
			boundary.source === 'user' &&
			state.order.at(-1) === boundaryId &&
			state.cursor.turnId !== boundaryId &&
			state.freshBoundaryId === boundaryId &&
			native.createdAt === state.cursor.createdAt &&
			(native.initialSessionId ?? null) === state.cursor.agentSessionId &&
			!native.conflicted &&
			run.provider === resolveAgentRunProvider(state.cursor.provider);
		if (state.cursor.runId || !valid) delete state.enrollment;
		state.cursor = {
			...state.cursor,
			revision: ++this.revision,
			runId: run.id,
			turnId: boundaryId ?? null,
		};
		state.reason = valid ? undefined : 'missing-native-boundary';
		if (valid) {
			state.freshBoundaryId = undefined;
			state.rows = new Map([[boundaryId!, boundary]]);
			state.rowRevisions = new Map([[boundaryId!, state.cursor.revision]]);
			state.contentRevisions = new Map([[boundaryId!, state.cursor.revision]]);
			state.contentSignatures = new Map([[boundaryId!, state.contentSignatures.get(boundaryId!)!]]);
			state.questionSignatures = new Map([[boundaryId!, null]]);
			state.order = [boundaryId!];
			const bytes = state.rowBytes.get(boundaryId!)!;
			state.rowBytes = new Map([[boundaryId!, bytes]]);
			this.retainedBytes += bytes - state.bytes;
			state.bytes = bytes;
		}
	}

	/** Final spawn fence: only the owner renderer's specifically submitted reply row
	 * may extend the classified turn during asynchronous spawn preparation. */
	assertDelivery(
		cursor: CurrentTurnCursor,
		count: number,
		boundaryId: string | undefined,
		text: string,
		questionSignatures?: string[] | null
	): boolean {
		const state = this.states.get(this.key(cursor.agentId, cursor.tabId));
		if (!state) throw new Error('Native delivery base lost');

		const unchanged = canonicalJson(state.cursor) === canonicalJson(cursor) && !state.reason;
		if (
			!unchanged &&
			(!boundaryId ||
				state.reason !== 'new-user-boundary' ||
				canonicalJson({ ...state.cursor, revision: cursor.revision }) !== canonicalJson(cursor) ||
				state.orderMutationRevision > cursor.revision ||
				state.order.length !== count + 1 ||
				state.order.at(-1) !== boundaryId ||
				state.order
					.slice(0, count)
					.some((id) => (state.rowRevisions.get(id) ?? Infinity) > cursor.revision))
		)
			throw new Error('Native turn changed during delivery');
		if (
			questionSignatures !== undefined &&
			canonicalJson(questionSignatures) !==
				canonicalJson(state.questionSignatures.get(state.order[count - 1]) ?? null)
		)
			throw new Error('Native question evidence changed during delivery');
		if (unchanged) return false;
		const reply = state.rows.get(boundaryId!);
		if (reply?.source !== 'user' || reply.text !== text)
			throw new Error('Native reply boundary mismatch');
		return true;
	}

	read(
		binding: {
			agentId: string;
			tabId: string;
			createdAt: number;
			provider: string;
			agentSessionId: string | null;
			open: boolean;
		},
		expected?: CurrentTurnCursor,
		includeMessages = true,
		deltaBase?: CurrentTurnCursor
	): CurrentTurnRead {
		if (!this.enabled) this.expireObservers();
		const state = this.states.get(this.key(binding.agentId, binding.tabId));
		const cursor: CurrentTurnCursor = state
			? { ...state.cursor }
			: {
					generation: this.generation,
					sourceGeneration: '',
					agentId: binding.agentId,
					tabId: binding.tabId,
					createdAt: binding.createdAt,
					provider: binding.provider,
					agentSessionId: binding.agentSessionId,
					revision: this.revision,
					runId: null,
					turnId: null,
				};
		const result = (status: CurrentTurnRead['status'], reason?: string): CurrentTurnRead => ({
			version: 1,
			cursor,
			status,
			reason,
			...(status === 'incomplete' && state?.enrollment && { enrollment: { ...state.enrollment } }),
			messages: [],
		});
		if (!state) return result('unknown', 'native-transcript-unavailable-or-evicted');
		if (
			!binding.open ||
			binding.createdAt !== cursor.createdAt ||
			binding.provider !== cursor.provider
		) {
			if (state.reason !== 'native-binding-changed') state.cursor.revision = ++this.revision;
			state.reason = 'native-binding-changed';
			delete state.enrollment;
			cursor.revision = state.cursor.revision;
			return result('reset', state.reason);
		}
		// Disk metadata can lag the first native provider announcement. Never read
		// across that mismatch, but let the confirmed commit become readable when it catches up.
		if (binding.agentSessionId !== cursor.agentSessionId)
			return result(
				state.enrollment && state.pendingAnnouncement ? 'incomplete' : 'reset',
				'native-provider-binding-pending'
			);
		if (expected && canonicalJson(expected) !== canonicalJson(cursor))
			return result(
				expected.generation !== cursor.generation ||
					expected.runId !== cursor.runId ||
					expected.turnId !== cursor.turnId
					? 'reset'
					: 'gap',
				'expected-cursor-changed'
			);
		if (
			state.enrollment &&
			!state.order.length &&
			!cursor.runId &&
			!cursor.agentSessionId &&
			!state.pendingAnnouncement
		)
			return { ...result('empty-enrollment'), enrollment: { ...state.enrollment }, entryCount: 0 };
		if (state.pendingAnnouncement)
			return result('incomplete', 'native-provider-announcement-unconfirmed');
		if (state.reason || !cursor.runId || !cursor.turnId)
			return result('incomplete', state.reason ?? 'missing-native-boundary');
		const delta =
			includeMessages &&
			deltaBase &&
			deltaBase.revision <= cursor.revision &&
			canonicalJson({ ...deltaBase, revision: cursor.revision }) === canonicalJson(cursor);
		return {
			version: 1,
			cursor,
			status: 'complete',
			...(state.enrollment && { enrollment: { ...state.enrollment } }),
			entryCount: state.order.length,
			lastEntry: state.order.length
				? {
						id: state.order.at(-1)!,
						textLength: state.rows.get(state.order.at(-1)!)!.text.length,
						contentRevision: state.contentRevisions.get(state.order.at(-1)!),
						contentSignature: state.contentSignatures.get(state.order.at(-1)!),
						questionSignatures: state.questionSignatures.get(state.order.at(-1)!)?.slice() ?? null,
						orderMutationRevision: state.orderMutationRevision,
					}
				: undefined,
			mode: delta ? 'delta' : 'full',
			...(delta ? { baseCursor: deltaBase, orderIds: [...state.order] } : {}),
			messages: includeMessages
				? state.order
						.filter(
							(id) => !delta || (state.rowRevisions.get(id) ?? Infinity) > deltaBase!.revision
						)
						.map((id) => structuredClone(state.rows.get(id)!))
				: [],
		};
	}
}

export const nativeCurrentTurns = new NativeCurrentTurns(undefined, false);
