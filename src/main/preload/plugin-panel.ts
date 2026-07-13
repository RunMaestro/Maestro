import { contextBridge, ipcRenderer } from 'electron';

declare const window: {
	addEventListener(type: 'unload', listener: () => void): void;
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

const REQUEST_CHANNEL = 'maestro:panel-request';
const SUBSCRIBE_CHANNEL = 'maestro:panel-subscribe';
const UNSUBSCRIBE_CHANNEL = 'maestro:panel-unsubscribe';
const UNSUBSCRIBE_ALL_CHANNEL = 'maestro:panel-unsubscribe-all';
const INIT_CHANNEL = 'maestro:panel-init';
const RESULT_CHANNEL = 'maestro:panel-result';
const ERROR_CHANNEL = 'maestro:panel-error';
const EVENT_CHANNEL = 'maestro:panel-event';
const STAGE_RESOURCE_CHANNEL = 'maestro:panel-stage-resource';
const RESOURCE_STAGED_CHANNEL = 'maestro:panel-resource-staged';
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_REQUESTS_PER_SECOND = 120;
const MAX_GENERATION_DECIMAL = '18446744073709551615';
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;

let instanceId: string | null = null;
let generation = '';
let highestGeneration = '';
let initialized = false;
let nextRequestId = 1;
let nextStageId = 1;
let windowStartedAt = 0;
let windowCount = 0;
interface PendingRequest {
	readonly kind: string;
	readonly payload: unknown;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}
const pending = new Map<number, PendingRequest>();
const pendingStages = new Map<
	number,
	{ resolve(value: unknown): void; reject(error: Error): void }
>();
const subscriptions = new Map<string, Set<(payload: unknown) => void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBoundedJson(value: unknown): boolean {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PAYLOAD_BYTES;
	} catch {
		return false;
	}
}

function isCurrentInstance(value: unknown): value is string {
	return typeof value === 'string' && instanceId !== null && value === instanceId;
}

function isBoundedGenerationDecimal(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[1-9][0-9]*$/.test(value) &&
		(value.length < MAX_GENERATION_DECIMAL.length ||
			(value.length === MAX_GENERATION_DECIMAL.length && value <= MAX_GENERATION_DECIMAL))
	);
}

function isStaleGeneration(nextGeneration: string): boolean {
	return (
		highestGeneration !== '' &&
		(nextGeneration.length < highestGeneration.length ||
			(nextGeneration.length === highestGeneration.length && nextGeneration < highestGeneration))
	);
}

function failClosed(reason: string): void {
	for (const entry of pending.values()) entry.reject(new Error(reason));
	for (const entry of pendingStages.values()) entry.reject(new Error(reason));
	pending.clear();
	pendingStages.clear();
	subscriptions.clear();
	instanceId = null;
	generation = '';
	initialized = false;
	nextRequestId = 1;
	nextStageId = 1;
	windowStartedAt = 0;
	windowCount = 0;
}

function flushPreInitState(): void {
	if (!initialized || instanceId === null) return;
	for (const [requestId, entry] of pending) {
		ipcRenderer.sendToHost(REQUEST_CHANNEL, {
			instanceId,
			requestId,
			kind: entry.kind,
			payload: entry.payload,
		});
	}
	for (const kind of subscriptions.keys()) {
		ipcRenderer.sendToHost(SUBSCRIBE_CHANNEL, { instanceId, kind });
	}
}

function initializeInstance(nextInstanceId: string, nextGeneration: string): void {
	if (initialized && instanceId === nextInstanceId && generation === nextGeneration) return;
	if (initialized) failClosed('panel instance replaced');
	instanceId = nextInstanceId;
	generation = nextGeneration;
	highestGeneration = nextGeneration;
	initialized = true;
	flushPreInitState();
}

function isLegacyInvokeCommand(value: unknown): value is {
	readonly type: 'maestro:invokeCommand';
	readonly commandId: string;
	readonly args?: unknown;
} {
	if (
		!isRecord(value) ||
		value.type !== 'maestro:invokeCommand' ||
		typeof value.commandId !== 'string' ||
		value.commandId.length === 0 ||
		value.commandId.length > 256
	) {
		return false;
	}
	const keys = Object.keys(value);
	return (
		keys.every((key) => key === 'type' || key === 'commandId' || key === 'args') &&
		hasBoundedJson({ commandId: value.commandId, args: value.args })
	);
}
const maestroInteractivePanel = Object.freeze({
	request(kind: string, payload: unknown): Promise<unknown> {
		if (typeof kind !== 'string' || kind.length === 0 || !hasBoundedJson(payload)) {
			return Promise.reject(new Error('interactive panel capability unavailable'));
		}
		if (pending.size >= MAX_PENDING_REQUESTS)
			return Promise.reject(new Error('interactive panel backpressure'));
		const now = Date.now();
		if (now - windowStartedAt >= 1_000) {
			windowStartedAt = now;
			windowCount = 0;
		}
		if (windowCount >= MAX_REQUESTS_PER_SECOND)
			return Promise.reject(new Error('interactive panel backpressure'));
		windowCount += 1;
		const requestId = nextRequestId++;
		return new Promise<unknown>((resolve, reject) => {
			pending.set(requestId, { kind, payload, resolve, reject });
			if (initialized && instanceId !== null) {
				ipcRenderer.sendToHost(REQUEST_CHANNEL, { instanceId, requestId, kind, payload });
			}
		});
	},

	stageResource(name: string, mediaType: string, bytes: Uint8Array): Promise<unknown> {
		if (
			instanceId === null ||
			typeof name !== 'string' ||
			typeof mediaType !== 'string' ||
			!(bytes instanceof Uint8Array) ||
			bytes.byteLength < 1 ||
			bytes.byteLength > MAX_RESOURCE_BYTES
		)
			return Promise.reject(new Error('interactive panel resource capability unavailable'));
		const stageId = nextStageId++;
		return new Promise<unknown>((resolve, reject) => {
			pendingStages.set(stageId, { resolve, reject });
			ipcRenderer.sendToHost(STAGE_RESOURCE_CHANNEL, {
				instanceId,
				stageId,
				name,
				mediaType,
				bytes,
			});
		});
	},

	subscribe(kind: string, listener: (payload: unknown) => void): () => void {
		if (typeof kind !== 'string' || kind.length === 0 || typeof listener !== 'function') {
			return () => undefined;
		}
		let listeners = subscriptions.get(kind);
		const first = listeners === undefined;
		if (!listeners) {
			listeners = new Set();
			subscriptions.set(kind, listeners);
		}
		listeners.add(listener);
		if (first && initialized && instanceId !== null) {
			ipcRenderer.sendToHost(SUBSCRIBE_CHANNEL, { instanceId, kind });
		}
		return () => {
			const current = subscriptions.get(kind);
			if (!current || !current.delete(listener) || current.size > 0) return;
			subscriptions.delete(kind);
			if (instanceId !== null) ipcRenderer.sendToHost(UNSUBSCRIBE_CHANNEL, { instanceId, kind });
		};
	},
});

contextBridge.exposeInMainWorld('maestroInteractivePanel', maestroInteractivePanel);

window.addEventListener('message', (event) => {
	if (event.source !== (window as unknown) || !isLegacyInvokeCommand(event.data)) return;
	ipcRenderer.sendToHost('maestro:invokeCommand', {
		commandId: event.data.commandId,
		args: event.data.args,
	});
});

ipcRenderer.on(INIT_CHANNEL, (_event, payload: unknown) => {
	if (
		!isRecord(payload) ||
		typeof payload.instanceId !== 'string' ||
		payload.instanceId.length < 16 ||
		payload.instanceId.length > 128 ||
		!isBoundedGenerationDecimal(payload.generation) ||
		isStaleGeneration(payload.generation)
	) {
		failClosed('panel init rejected');
		return;
	}
	initializeInstance(payload.instanceId, payload.generation);
});

ipcRenderer.on(RESULT_CHANNEL, (_event, payload: unknown) => {
	if (
		!isRecord(payload) ||
		!isCurrentInstance(payload.instanceId) ||
		!Number.isSafeInteger(payload.requestId)
	)
		return;
	const entry = pending.get(payload.requestId as number);
	if (!entry || !hasBoundedJson(payload.payload)) return;
	pending.delete(payload.requestId as number);
	entry.resolve(payload.payload);
});

ipcRenderer.on(ERROR_CHANNEL, (_event, payload: unknown) => {
	if (
		!isRecord(payload) ||
		!isCurrentInstance(payload.instanceId) ||
		!Number.isSafeInteger(payload.requestId)
	)
		return;
	const entry = pending.get(payload.requestId as number);
	if (!entry || typeof payload.code !== 'string' || payload.code.length > 128) return;
	pending.delete(payload.requestId as number);
	entry.reject(new Error(payload.code));
});

ipcRenderer.on(RESOURCE_STAGED_CHANNEL, (_event, payload: unknown) => {
	if (
		!isRecord(payload) ||
		!isCurrentInstance(payload.instanceId) ||
		!Number.isSafeInteger(payload.stageId) ||
		!isRecord(payload.resource)
	)
		return;
	const resource = payload.resource;
	const ref = resource.ref;
	const name = resource.name;
	const mediaType = resource.mediaType;
	const size = resource.size;
	const sha256 = resource.sha256;
	if (
		typeof ref !== 'string' ||
		typeof name !== 'string' ||
		typeof mediaType !== 'string' ||
		typeof size !== 'number' ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		size > MAX_RESOURCE_BYTES ||
		typeof sha256 !== 'string' ||
		!/^[a-f0-9]{64}$/.test(sha256)
	)
		return;
	const entry = pendingStages.get(payload.stageId as number);
	if (!entry) return;
	pendingStages.delete(payload.stageId as number);
	entry.resolve(
		Object.freeze({
			ref,
			name,
			mediaType,
			size,
			sha256,
		})
	);
});

ipcRenderer.on(EVENT_CHANNEL, (_event, payload: unknown) => {
	if (
		!isRecord(payload) ||
		!isCurrentInstance(payload.instanceId) ||
		typeof payload.kind !== 'string' ||
		!hasBoundedJson(payload.payload)
	)
		return;
	const listeners = subscriptions.get(payload.kind);
	if (!listeners) return;
	for (const listener of [...listeners]) {
		try {
			listener(payload.payload);
		} catch {
			// A guest listener cannot compromise host transport delivery.
		}
	}
});

window.addEventListener('unload', () => {
	if (initialized && instanceId !== null) {
		ipcRenderer.sendToHost(UNSUBSCRIBE_ALL_CHANNEL, { instanceId });
	}
	failClosed('panel unloaded');
});
