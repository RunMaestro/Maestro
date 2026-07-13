import { contextBridge, ipcRenderer } from 'electron';

declare const window: {
	addEventListener(type: 'unload', listener: () => void): void;
};

const REQUEST_CHANNEL = 'maestro:panel-request';
const SUBSCRIBE_CHANNEL = 'maestro:panel-subscribe';
const UNSUBSCRIBE_CHANNEL = 'maestro:panel-unsubscribe';
const UNSUBSCRIBE_ALL_CHANNEL = 'maestro:panel-unsubscribe-all';
const INIT_CHANNEL = 'maestro:panel-init';
const RESULT_CHANNEL = 'maestro:panel-result';
const ERROR_CHANNEL = 'maestro:panel-error';
const EVENT_CHANNEL = 'maestro:panel-event';
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_REQUESTS_PER_SECOND = 120;

let instanceId: string | null = null;
let nextRequestId = 1;
let windowStartedAt = 0;
let windowCount = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
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

function resetInstance(nextInstanceId: string): void {
	for (const entry of pending.values()) entry.reject(new Error('panel instance replaced'));
	pending.clear();
	subscriptions.clear();
	instanceId = nextInstanceId;
	nextRequestId = 1;
	windowStartedAt = 0;
	windowCount = 0;
}

const maestroInteractivePanel = Object.freeze({
	request(kind: string, payload: unknown): Promise<unknown> {
		if (
			instanceId === null ||
			typeof kind !== 'string' ||
			kind.length === 0 ||
			!hasBoundedJson(payload)
		) {
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
			pending.set(requestId, { resolve, reject });
			ipcRenderer.sendToHost(REQUEST_CHANNEL, { instanceId, requestId, kind, payload });
		});
	},

	subscribe(kind: string, listener: (payload: unknown) => void): () => void {
		if (
			instanceId === null ||
			typeof kind !== 'string' ||
			kind.length === 0 ||
			typeof listener !== 'function'
		) {
			return () => undefined;
		}
		let listeners = subscriptions.get(kind);
		const first = listeners === undefined;
		if (!listeners) {
			listeners = new Set();
			subscriptions.set(kind, listeners);
		}
		listeners.add(listener);
		if (first) ipcRenderer.sendToHost(SUBSCRIBE_CHANNEL, { instanceId, kind });
		return () => {
			const current = subscriptions.get(kind);
			if (!current || !current.delete(listener) || current.size > 0) return;
			subscriptions.delete(kind);
			if (instanceId !== null) ipcRenderer.sendToHost(UNSUBSCRIBE_CHANNEL, { instanceId, kind });
		};
	},
});

contextBridge.exposeInMainWorld('maestroInteractivePanel', maestroInteractivePanel);

ipcRenderer.on(INIT_CHANNEL, (_event, payload: unknown) => {
	if (
		!isRecord(payload) ||
		typeof payload.instanceId !== 'string' ||
		payload.instanceId.length < 16 ||
		payload.instanceId.length > 128 ||
		(typeof payload.generation !== 'bigint' &&
			(typeof payload.generation !== 'number' || !Number.isSafeInteger(payload.generation)))
	)
		return;
	resetInstance(payload.instanceId);
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
	if (instanceId !== null) ipcRenderer.sendToHost(UNSUBSCRIBE_ALL_CHANNEL, { instanceId });
	for (const entry of pending.values()) entry.reject(new Error('panel unloaded'));
	pending.clear();
	subscriptions.clear();
	instanceId = null;
});
