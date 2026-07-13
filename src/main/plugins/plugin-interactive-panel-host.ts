import { randomUUID } from 'node:crypto';
import {
	compileCanonicalJsonSchema,
	measureJsonValue,
	type CompiledCanonicalJsonSchema,
} from '../../shared/plugins/canonical-json-schema';
import type {
	ClosedPanelBridge,
	JsonSchema,
	JsonValue,
	MaestroInteractivePanelOwnerApi,
	PanelErrorCode,
	PanelRequest,
	UUID,
} from '../../shared/plugins/interactive-panel';

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_INGRESS_QUEUED_BYTES = 256 * 1024;
const MAX_EGRESS_QUEUED_BYTES = 512 * 1024;
const MAX_GLOBAL_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_INGRESS_MESSAGES_PER_SECOND = 20;
const MAX_INGRESS_BYTES_PER_SECOND = 256 * 1024;
const MAX_EGRESS_EVENTS_PER_SECOND = 128;
const MAX_EGRESS_BYTES_PER_SECOND = 512 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_VIOLATIONS = 8;
const VIOLATION_WINDOW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type PanelTimer = number | object;

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

/** Injected time is a test seam and makes rate windows and request expiry deterministic. */
export interface InteractivePanelHostScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): PanelTimer;
	clearTimeout(handle: PanelTimer): void;
}

export interface PluginInteractivePanelHostOptions {
	readonly scheduler?: InteractivePanelHostScheduler;
	readonly requestTimeoutMs?: number;
}

interface PendingRequest {
	readonly guestRequestId: number;
	readonly kind: string;
	readonly mount: MountRecord;
	readonly bytes: number;
	readonly timeout: PanelTimer;
}

interface EgressEvent {
	readonly channel: 'maestro:panel-event';
	readonly payload: JsonValue;
	readonly bytes: number;
	readonly coalescible: boolean;
	readonly kind: string;
}

interface RateWindow {
	startedAt: number;
	count: number;
	bytes: number;
}

interface MountRecord {
	readonly instanceId: string;
	readonly mount: InteractivePanelMount;
	readonly descriptor: CompiledDescriptor;
	readonly pending: Map<string, PendingRequest>;
	readonly subscriptions: Set<string>;
	readonly egress: EgressEvent[];
	readonly violations: number[];
	readonly ingressRate: RateWindow;
	readonly egressRate: RateWindow;
	ingressQueuedBytes: number;
	egressQueuedBytes: number;
	lastEventSequence: bigint | undefined;
	egressTimer: PanelTimer | undefined;
}

interface CompiledDescriptor {
	readonly requests: ReadonlyMap<string, CompiledCanonicalJsonSchema>;
	readonly events: ReadonlyMap<string, CompiledCanonicalJsonSchema>;
	readonly results: ReadonlyMap<string, CompiledCanonicalJsonSchema>;
	readonly errors: ReadonlyMap<string, CompiledCanonicalJsonSchema>;
}

type OwnerKey = string;
type OwnerRequestListener = (request: PanelRequest<string, JsonValue>) => void;

const descriptorCache = new WeakMap<object, CompiledDescriptor>();
const defaultScheduler: InteractivePanelHostScheduler = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => {
		const timer = handle as NodeJS.Timeout;
		clearTimeout(timer);
	},
};

function ownerKey(ownerPluginId: string, generation: bigint): OwnerKey {
	return `${ownerPluginId}\u0000${generation.toString(10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function compileSchemaMap(
	value: Readonly<Record<string, JsonSchema>>
): ReadonlyMap<string, CompiledCanonicalJsonSchema> | null {
	if (!isRecord(value)) return null;
	const compiled = new Map<string, CompiledCanonicalJsonSchema>();
	for (const key of Object.keys(value)) {
		const schema = ownValue(value, key);
		if (!isRecord(schema)) return null;
		const canonical = ownValue(schema, 'canonicalJsonSchema');
		const validator = compileCanonicalJsonSchema(canonical);
		if (!validator) return null;
		compiled.set(key, validator);
	}
	return compiled;
}

function compileDescriptor(descriptor: InteractivePanelDescriptor): CompiledDescriptor | null {
	if (!isRecord(descriptor)) return null;
	if (Object.isFrozen(descriptor)) {
		const cached = descriptorCache.get(descriptor);
		if (cached) return cached;
	}
	const requests = compileSchemaMap(descriptor.requestSchemas);
	const events = compileSchemaMap(descriptor.eventSchemas);
	const results = compileSchemaMap(descriptor.resultSchemas);
	const errors = compileSchemaMap(descriptor.errorSchemas);
	if (!requests || !events || !results || !errors) return null;
	const compiled = Object.freeze({ requests, events, results, errors });
	if (Object.isFrozen(descriptor)) descriptorCache.set(descriptor, compiled);
	return compiled;
}

function validTimeout(value: number | undefined): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0
		? value
		: DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Owner/instance/generation-bound closed panel broker. It has no Electron IPC
 * dependency: a trusted renderer binder supplies one sender per mounted guest,
 * and the guest preload can forward only the fixed request/subscribe channels.
 */
export class PluginInteractivePanelHost {
	private readonly mounts = new Map<string, MountRecord>();
	private readonly ownerListeners = new Map<OwnerKey, Set<OwnerRequestListener>>();
	private readonly scheduler: InteractivePanelHostScheduler;
	private readonly requestTimeoutMs: number;
	private globalQueuedBytes = 0;
	private globalEgressRate: RateWindow;

	constructor(options: PluginInteractivePanelHostOptions = {}) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.requestTimeoutMs = validTimeout(options.requestTimeoutMs);
		this.globalEgressRate = { startedAt: this.scheduler.now(), count: 0, bytes: 0 };
	}

	mount(mount: InteractivePanelMount): InteractivePanelMountHandle {
		const descriptor = compileDescriptor(mount.descriptor);
		if (!descriptor)
			throw new TypeError('Interactive panel descriptor contains an invalid canonical JSON schema');
		this.unmountByContribution(mount.ownerPluginId, mount.workspaceLocalId, mount.panelLocalId);
		const instanceId = randomUUID();
		const now = this.scheduler.now();
		const record: MountRecord = {
			instanceId,
			mount,
			descriptor,
			pending: new Map(),
			subscriptions: new Set(),
			egress: [],
			violations: [],
			ingressRate: { startedAt: now, count: 0, bytes: 0 },
			egressRate: { startedAt: now, count: 0, bytes: 0 },
			ingressQueuedBytes: 0,
			egressQueuedBytes: 0,
			lastEventSequence: undefined,
			egressTimer: undefined,
		};
		this.mounts.set(instanceId, record);
		this.sendControl(record, 'maestro:panel-init', {
			instanceId,
			generation: mount.generation.toString(10),
		});
		return Object.freeze({ instanceId, dispose: () => this.unmount(instanceId) });
	}

	/** Receives only a message emitted through the exact guest sender installed at mount. */
	receive(sender: InteractivePanelGuestSender, channel: string, payload: unknown): void {
		if (!isRecord(payload)) return;
		const instanceId = ownValue(payload, 'instanceId');
		if (typeof instanceId !== 'string') return;
		const record = this.mounts.get(instanceId);
		if (!record || record.mount.sender !== sender) return;
		const measurement = measureJsonValue(payload, {
			maxDepth: MAX_JSON_DEPTH,
			maxNodes: MAX_JSON_NODES,
			maxBytes: MAX_MESSAGE_BYTES,
		});
		if (!measurement) {
			this.violate(record);
			return;
		}
		if (channel === 'maestro:panel-request') {
			this.receiveRequest(record, payload, measurement.bytes);
			return;
		}
		if (!this.reserveIngressRate(record, measurement.bytes)) {
			const requestId = ownValue(payload, 'requestId');
			const kind = ownValue(payload, 'kind');
			this.sendError(record, requestId, typeof kind === 'string' ? kind : '', 'backpressure');
			this.violate(record);
			return;
		}
		if (channel === 'maestro:panel-subscribe') {
			const kind = ownValue(payload, 'kind');
			if (typeof kind !== 'string' || !record.descriptor.events.has(kind)) {
				this.violate(record);
				return;
			}
			record.subscriptions.add(kind);
			return;
		}
		if (channel === 'maestro:panel-unsubscribe') {
			const kind = ownValue(payload, 'kind');
			if (typeof kind === 'string') record.subscriptions.delete(kind);
			return;
		}
		if (channel === 'maestro:panel-unsubscribe-all') {
			record.subscriptions.clear();
			return;
		}
		this.violate(record);
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
				this.emit(ownerPluginId, generation, kind, payload, eventSequence);
			},
		});
	}

	unmount(instanceId: string): void {
		const record = this.mounts.get(instanceId);
		if (!record) return;
		this.mounts.delete(instanceId);
		for (const pending of record.pending.values()) this.scheduler.clearTimeout(pending.timeout);
		this.globalQueuedBytes -= record.ingressQueuedBytes + record.egressQueuedBytes;
		record.pending.clear();
		record.subscriptions.clear();
		record.egress.length = 0;
		record.ingressQueuedBytes = 0;
		record.egressQueuedBytes = 0;
		if (record.egressTimer !== undefined) this.scheduler.clearTimeout(record.egressTimer);
		record.egressTimer = undefined;
	}

	revokeOwner(ownerPluginId: string): void {
		for (const [instanceId, record] of this.mounts) {
			if (record.mount.ownerPluginId === ownerPluginId) this.unmount(instanceId);
		}
		for (const key of this.ownerListeners.keys()) {
			if (key.startsWith(`${ownerPluginId}\u0000`)) this.ownerListeners.delete(key);
		}
	}

	private receiveRequest(
		record: MountRecord,
		payload: Record<string, unknown>,
		bytes: number
	): void {
		const requestId = ownValue(payload, 'requestId');
		const kind = ownValue(payload, 'kind');
		if (!this.reserveIngressRate(record, bytes)) {
			this.sendError(record, requestId, typeof kind === 'string' ? kind : '', 'backpressure');
			this.violate(record);
			return;
		}
		const requestPayload = ownValue(payload, 'payload');
		if (
			typeof requestId !== 'number' ||
			!Number.isSafeInteger(requestId) ||
			requestId < 1 ||
			typeof kind !== 'string'
		) {
			this.sendError(record, requestId, typeof kind === 'string' ? kind : '', 'invalid_request');
			this.violate(record);
			return;
		}
		const validator = record.descriptor.requests.get(kind);
		if (
			!validator ||
			!validator.validate(requestPayload, {
				maxDepth: MAX_JSON_DEPTH,
				maxNodes: MAX_JSON_NODES,
				maxBytes: MAX_MESSAGE_BYTES,
			}) ||
			this.hasGuestRequestId(record, requestId)
		) {
			this.sendError(record, requestId, kind, 'invalid_request');
			this.violate(record);
			return;
		}
		if (
			record.pending.size >= MAX_PENDING_REQUESTS ||
			record.ingressQueuedBytes + bytes > MAX_INGRESS_QUEUED_BYTES ||
			this.globalQueuedBytes + bytes > MAX_GLOBAL_QUEUED_BYTES
		) {
			this.sendError(record, requestId, kind, 'backpressure');
			this.violate(record);
			return;
		}
		const ownerListeners = this.ownerListeners.get(
			ownerKey(record.mount.ownerPluginId, record.mount.generation)
		);
		if (!ownerListeners || ownerListeners.size === 0) {
			this.sendError(record, requestId, kind, 'capability_unavailable');
			return;
		}
		const ownerRequestId = randomUUID() as UUID;
		const timeout = this.scheduler.setTimeout(() => {
			this.timeout(record.instanceId, ownerRequestId);
		}, this.requestTimeoutMs);
		const pending: PendingRequest = {
			guestRequestId: requestId,
			kind,
			mount: record,
			bytes,
			timeout,
		};
		record.pending.set(ownerRequestId, pending);
		record.ingressQueuedBytes += bytes;
		this.globalQueuedBytes += bytes;
		const request = Object.freeze({ kind, requestId: ownerRequestId, payload: requestPayload });
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
				break;
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
			this.takePending(record, ownerRequestId, pending);
			if (error) {
				this.sendError(record, pending.guestRequestId, pending.kind, error);
				return;
			}
			const validator = kind === undefined ? undefined : record.descriptor.results.get(kind);
			if (
				kind !== pending.kind ||
				!validator ||
				!validator.validate(payload, {
					maxDepth: MAX_JSON_DEPTH,
					maxNodes: MAX_JSON_NODES,
					maxBytes: MAX_MESSAGE_BYTES,
				})
			) {
				this.sendError(record, pending.guestRequestId, pending.kind, 'invalid_request');
				return;
			}
			this.sendControl(record, 'maestro:panel-result', {
				instanceId: record.instanceId,
				requestId: pending.guestRequestId,
				kind,
				payload,
			});
			return;
		}
	}

	private emit(
		ownerPluginId: string,
		generation: bigint,
		kind: string,
		payload: JsonValue,
		eventSequence: bigint
	): void {
		if (typeof kind !== 'string' || typeof eventSequence !== 'bigint') return;
		for (const record of this.mounts.values()) {
			if (
				record.mount.ownerPluginId !== ownerPluginId ||
				record.mount.generation !== generation ||
				!record.subscriptions.has(kind)
			)
				continue;
			const validator = record.descriptor.events.get(kind);
			if (
				!validator ||
				!validator.validate(payload, {
					maxDepth: MAX_JSON_DEPTH,
					maxNodes: MAX_JSON_NODES,
					maxBytes: MAX_MESSAGE_BYTES,
				}) ||
				(record.lastEventSequence !== undefined && eventSequence <= record.lastEventSequence)
			)
				continue;
			const envelope: JsonValue = {
				instanceId: record.instanceId,
				kind,
				payload,
				eventSequence: eventSequence.toString(10),
			};
			const measurement = measureJsonValue(envelope, {
				maxDepth: MAX_JSON_DEPTH,
				maxNodes: MAX_JSON_NODES,
				maxBytes: MAX_MESSAGE_BYTES,
			});
			if (!measurement || !this.reserveEgressRate(record, measurement.bytes)) continue;
			if (
				record.egressQueuedBytes + measurement.bytes > MAX_EGRESS_QUEUED_BYTES ||
				this.globalQueuedBytes + measurement.bytes > MAX_GLOBAL_QUEUED_BYTES
			)
				continue;
			record.lastEventSequence = eventSequence;
			this.enqueueEvent(record, {
				channel: 'maestro:panel-event',
				payload: envelope,
				bytes: measurement.bytes,
				coalescible: kind.endsWith('.delta'),
				kind,
			});
		}
	}

	private enqueueEvent(record: MountRecord, event: EgressEvent): void {
		const last = record.egress.at(-1);
		if (event.coalescible && last?.coalescible && last.kind === event.kind) {
			record.egressQueuedBytes -= last.bytes;
			this.globalQueuedBytes -= last.bytes;
			record.egress[record.egress.length - 1] = event;
		} else {
			record.egress.push(event);
		}
		record.egressQueuedBytes += event.bytes;
		this.globalQueuedBytes += event.bytes;
		if (record.egressTimer !== undefined) return;
		record.egressTimer = this.scheduler.setTimeout(() => this.flushEvents(record.instanceId), 0);
	}

	private flushEvents(instanceId: string): void {
		const record = this.mounts.get(instanceId);
		if (!record) return;
		record.egressTimer = undefined;
		while (record.egress.length > 0) {
			const event = record.egress.shift();
			if (!event) return;
			record.egressQueuedBytes -= event.bytes;
			this.globalQueuedBytes -= event.bytes;
			record.mount.sender.send(event.channel, event.payload);
		}
	}

	private timeout(instanceId: string, ownerRequestId: UUID): void {
		const record = this.mounts.get(instanceId);
		if (!record) return;
		const pending = record.pending.get(ownerRequestId);
		if (!pending) return;
		this.takePending(record, ownerRequestId, pending);
		this.sendError(record, pending.guestRequestId, pending.kind, 'timeout');
	}

	private takePending(record: MountRecord, ownerRequestId: UUID, pending: PendingRequest): void {
		record.pending.delete(ownerRequestId);
		this.scheduler.clearTimeout(pending.timeout);
		record.ingressQueuedBytes -= pending.bytes;
		this.globalQueuedBytes -= pending.bytes;
	}

	private sendError(
		record: MountRecord,
		requestId: unknown,
		kind: string,
		code: PanelErrorCode
	): void {
		if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 1) return;
		this.sendControl(record, 'maestro:panel-error', {
			instanceId: record.instanceId,
			requestId,
			kind,
			code,
		});
	}

	private sendControl(
		record: MountRecord,
		channel: Exclude<PanelHostChannel, 'maestro:panel-event'>,
		payload: JsonValue
	): void {
		if (!this.mounts.has(record.instanceId)) return;
		const measurement = measureJsonValue(payload, {
			maxDepth: MAX_JSON_DEPTH,
			maxNodes: MAX_JSON_NODES,
			maxBytes: MAX_MESSAGE_BYTES,
		});
		if (!measurement) return;
		record.mount.sender.send(channel, payload);
	}

	private reserveIngressRate(record: MountRecord, bytes: number): boolean {
		this.resetWindow(record.ingressRate);
		if (
			record.ingressRate.count >= MAX_INGRESS_MESSAGES_PER_SECOND ||
			record.ingressRate.bytes + bytes > MAX_INGRESS_BYTES_PER_SECOND
		)
			return false;
		record.ingressRate.count += 1;
		record.ingressRate.bytes += bytes;
		return true;
	}

	private reserveEgressRate(record: MountRecord, bytes: number): boolean {
		this.resetWindow(record.egressRate);
		this.resetWindow(this.globalEgressRate);
		if (
			record.egressRate.count >= MAX_EGRESS_EVENTS_PER_SECOND ||
			record.egressRate.bytes + bytes > MAX_EGRESS_BYTES_PER_SECOND ||
			this.globalEgressRate.bytes + bytes > 64 * 1024 * 1024
		)
			return false;
		record.egressRate.count += 1;
		record.egressRate.bytes += bytes;
		this.globalEgressRate.count += 1;
		this.globalEgressRate.bytes += bytes;
		return true;
	}

	private resetWindow(window: RateWindow): void {
		const now = this.scheduler.now();
		if (now - window.startedAt < 1_000) return;
		window.startedAt = now;
		window.count = 0;
		window.bytes = 0;
	}

	private hasGuestRequestId(record: MountRecord, requestId: number): boolean {
		for (const pending of record.pending.values()) {
			if (pending.guestRequestId === requestId) return true;
		}
		return false;
	}

	private violate(record: MountRecord): void {
		const now = this.scheduler.now();
		record.violations.push(now);
		while (
			record.violations[0] !== undefined &&
			now - record.violations[0] >= VIOLATION_WINDOW_MS
		) {
			record.violations.shift();
		}
		if (record.violations.length >= MAX_VIOLATIONS) this.unmount(record.instanceId);
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
