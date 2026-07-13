import { randomUUID } from 'node:crypto';
import type {
	ClosedPanelBridge,
	JsonSchema,
	JsonValue,
	MaestroInteractivePanelOwnerApi,
	PanelErrorCode,
	PanelRequest,
	UUID,
} from '../../shared/plugins/interactive-panel';

const MAX_PENDING_REQUESTS = 32;
const MAX_REQUESTS_PER_SECOND = 120;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export type InteractivePanelDescriptor = ClosedPanelBridge;
export type PanelHostChannel =
	| 'maestro:panel-init'
	| 'maestro:panel-result'
	| 'maestro:panel-error'
	| 'maestro:panel-event';

/** The trusted renderer supplies this opaque sender while binding a webview.
 * Incoming guest messages must carry this exact object identity. */
export interface InteractivePanelGuestSender {
	send(channel: PanelHostChannel, payload: unknown): void;
}

export interface InteractivePanelMount {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: string;
	readonly panelLocalId: string;
	readonly generation: bigint;
	readonly descriptor: InteractivePanelDescriptor;
	readonly sender: InteractivePanelGuestSender;
}

export interface InteractivePanelMountHandle {
	readonly instanceId: string;
	dispose(): void;
}

interface PendingRequest {
	readonly guestRequestId: number;
	readonly kind: string;
	readonly mount: MountRecord;
}

interface MountRecord {
	readonly instanceId: string;
	readonly mount: InteractivePanelMount;
	readonly pending: Map<string, PendingRequest>;
	readonly subscriptions: Set<string>;
	windowStartedAt: number;
	windowCount: number;
}

type OwnerKey = string;
type OwnerRequestListener = (request: PanelRequest<string, JsonValue>) => void;

function ownerKey(ownerPluginId: string, generation: bigint): OwnerKey {
	return `${ownerPluginId}\u0000${generation.toString(10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > 32 || value === null) return depth <= 32;
	if (typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
	if (!isRecord(value)) return false;
	return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

function isBoundedJson(value: unknown): value is JsonValue {
	if (!isJsonValue(value)) return false;
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_PAYLOAD_BYTES;
	} catch {
		return false;
	}
}

/** Deliberately small, data-only JSON Schema evaluator. Unknown schema keywords
 * never widen authority; only canonical object/array/string/number/boolean/null
 * constraints are accepted. */
function matchesSchema(value: JsonValue, schema: JsonSchema | undefined): boolean {
	if (!schema) return true;
	const canonical = schema.canonicalJsonSchema;
	if (!isRecord(canonical)) return false;
	const type = canonical.type;
	if (type === 'object') {
		if (!isRecord(value)) return false;
		const required = canonical.required;
		if (
			Array.isArray(required) &&
			required.some((key) => typeof key !== 'string' || !(key in value))
		) {
			return false;
		}
		return true;
	}
	if (type === 'array') return Array.isArray(value);
	if (type === 'string') return typeof value === 'string';
	if (type === 'number' || type === 'integer') return typeof value === 'number';
	if (type === 'boolean') return typeof value === 'boolean';
	if (type === 'null') return value === null;
	return false;
}

/**
 * Owner/instance/generation-bound closed panel broker. It has no Electron IPC
 * dependency: a trusted renderer binder supplies one sender per mounted guest,
 * and the guest preload can forward only the fixed request/subscribe channels.
 */
export class PluginInteractivePanelHost {
	private readonly mounts = new Map<string, MountRecord>();
	private readonly ownerListeners = new Map<OwnerKey, Set<OwnerRequestListener>>();

	mount(mount: InteractivePanelMount): InteractivePanelMountHandle {
		this.unmountByContribution(mount.ownerPluginId, mount.workspaceLocalId, mount.panelLocalId);
		const instanceId = randomUUID();
		const record: MountRecord = {
			instanceId,
			mount,
			pending: new Map(),
			subscriptions: new Set(),
			windowStartedAt: Date.now(),
			windowCount: 0,
		};
		this.mounts.set(instanceId, record);
		mount.sender.send('maestro:panel-init', { instanceId, generation: mount.generation });
		return Object.freeze({ instanceId, dispose: () => this.unmount(instanceId) });
	}

	/** Receives only a message emitted through the exact guest sender installed at mount. */
	receive(sender: InteractivePanelGuestSender, channel: string, payload: unknown): void {
		if (!isRecord(payload) || typeof payload.instanceId !== 'string') return;
		const record = this.mounts.get(payload.instanceId);
		if (!record || record.mount.sender !== sender) return;
		if (channel === 'maestro:panel-request') {
			this.receiveRequest(record, payload);
			return;
		}
		if (channel === 'maestro:panel-subscribe') {
			if (typeof payload.kind !== 'string' || !record.mount.descriptor.eventSchemas[payload.kind])
				return;
			record.subscriptions.add(payload.kind);
			return;
		}
		if (channel === 'maestro:panel-unsubscribe') {
			if (typeof payload.kind === 'string') record.subscriptions.delete(payload.kind);
			return;
		}
		if (channel === 'maestro:panel-unsubscribe-all') record.subscriptions.clear();
	}

	ownerApi(ownerPluginId: string, generation: bigint): MaestroInteractivePanelOwnerApi {
		const key = ownerKey(ownerPluginId, generation);
		return Object.freeze({
			onRequest: (listener: OwnerRequestListener): (() => void) => {
				let listeners = this.ownerListeners.get(key);
				if (!listeners) {
					listeners = new Set();
					this.ownerListeners.set(key, listeners);
				}
				listeners.add(listener);
				return () => {
					listeners?.delete(listener);
					if (listeners?.size === 0) this.ownerListeners.delete(key);
				};
			},
			resolve: async (requestId: UUID, kind: string, payload: JsonValue): Promise<void> => {
				this.complete(ownerPluginId, generation, requestId, kind, payload, undefined);
			},
			reject: async (requestId: UUID, code: PanelErrorCode): Promise<void> => {
				this.complete(ownerPluginId, generation, requestId, undefined, undefined, code);
			},
			emit: async (kind: string, payload: JsonValue, eventSequence: bigint): Promise<void> => {
				if (
					!isBoundedJson(payload) ||
					typeof kind !== 'string' ||
					typeof eventSequence !== 'bigint'
				)
					return;
				for (const record of this.mounts.values()) {
					if (
						record.mount.ownerPluginId !== ownerPluginId ||
						record.mount.generation !== generation ||
						!record.subscriptions.has(kind) ||
						!matchesSchema(payload, record.mount.descriptor.eventSchemas[kind])
					)
						continue;
					record.mount.sender.send('maestro:panel-event', {
						instanceId: record.instanceId,
						kind,
						payload,
						eventSequence: eventSequence.toString(10),
					});
				}
			},
		});
	}

	unmount(instanceId: string): void {
		const record = this.mounts.get(instanceId);
		if (!record) return;
		this.mounts.delete(instanceId);
		record.pending.clear();
		record.subscriptions.clear();
	}

	revokeOwner(ownerPluginId: string): void {
		for (const [instanceId, record] of this.mounts) {
			if (record.mount.ownerPluginId === ownerPluginId) this.unmount(instanceId);
		}
		for (const key of this.ownerListeners.keys()) {
			if (key.startsWith(`${ownerPluginId}\u0000`)) this.ownerListeners.delete(key);
		}
	}

	private receiveRequest(record: MountRecord, payload: Record<string, unknown>): void {
		const requestId = payload.requestId;
		const kind = payload.kind;
		if (
			!Number.isSafeInteger(requestId) ||
			(requestId as number) < 1 ||
			typeof kind !== 'string' ||
			!record.mount.descriptor.requestSchemas[kind] ||
			!isBoundedJson(payload.payload) ||
			!matchesSchema(payload.payload, record.mount.descriptor.requestSchemas[kind]) ||
			record.pending.size >= MAX_PENDING_REQUESTS
		) {
			this.sendError(record, requestId, typeof kind === 'string' ? kind : '', 'invalid_request');
			return;
		}
		const now = Date.now();
		if (now - record.windowStartedAt >= 1_000) {
			record.windowStartedAt = now;
			record.windowCount = 0;
		}
		if (record.windowCount >= MAX_REQUESTS_PER_SECOND) {
			this.sendError(record, requestId, kind, 'backpressure');
			return;
		}
		record.windowCount += 1;
		const ownerListeners = this.ownerListeners.get(
			ownerKey(record.mount.ownerPluginId, record.mount.generation)
		);
		if (!ownerListeners || ownerListeners.size === 0) {
			this.sendError(record, requestId, kind, 'capability_unavailable');
			return;
		}
		const ownerRequestId = randomUUID() as UUID;
		record.pending.set(ownerRequestId, {
			guestRequestId: requestId as number,
			kind,
			mount: record,
		});
		const request = Object.freeze({ kind, requestId: ownerRequestId, payload: payload.payload });
		for (const listener of [...ownerListeners]) {
			try {
				listener(request);
			} catch {
				this.complete(
					record.mount.ownerPluginId,
					record.mount.generation,
					ownerRequestId,
					undefined,
					undefined,
					'runtime_stopped'
				);
			}
		}
	}

	private complete(
		ownerPluginId: string,
		generation: bigint,
		ownerRequestId: UUID,
		kind: string | undefined,
		payload: JsonValue | undefined,
		error: PanelErrorCode | undefined
	): void {
		for (const record of this.mounts.values()) {
			const pending = record.pending.get(ownerRequestId);
			if (!pending || pending.mount !== record) continue;
			if (record.mount.ownerPluginId !== ownerPluginId || record.mount.generation !== generation)
				return;
			record.pending.delete(ownerRequestId);
			if (error) {
				this.sendError(record, pending.guestRequestId, pending.kind, error);
				return;
			}
			if (
				kind !== pending.kind ||
				!isBoundedJson(payload) ||
				!matchesSchema(payload, record.mount.descriptor.resultSchemas[kind])
			) {
				this.sendError(record, pending.guestRequestId, pending.kind, 'invalid_request');
				return;
			}
			record.mount.sender.send('maestro:panel-result', {
				instanceId: record.instanceId,
				requestId: pending.guestRequestId,
				kind,
				payload,
			});
			return;
		}
	}

	private sendError(
		record: MountRecord,
		requestId: unknown,
		kind: string,
		code: PanelErrorCode
	): void {
		if (!Number.isSafeInteger(requestId) || (requestId as number) < 1) return;
		record.mount.sender.send('maestro:panel-error', {
			instanceId: record.instanceId,
			requestId,
			kind,
			code,
		});
	}

	private unmountByContribution(
		ownerPluginId: string,
		workspaceLocalId: string,
		panelLocalId: string
	): void {
		for (const [instanceId, record] of this.mounts) {
			const mount = record.mount;
			if (
				mount.ownerPluginId === ownerPluginId &&
				mount.workspaceLocalId === workspaceLocalId &&
				mount.panelLocalId === panelLocalId
			)
				this.unmount(instanceId);
		}
	}
}
