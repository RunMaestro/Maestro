/**
 * Broker-only preload for plugin panel guests.
 *
 * The legacy one-way `maestro:invokeCommand` bridge remains unchanged. The
 * additional interactive path is deliberately closed: it accepts one tool
 * invocation method and one host event topic, is bound to a host-issued panel
 * instance, and is relayed only through fixed `sendToHost` channels. No
 * Electron object, Node API, generic IPC channel, or host capability reaches
 * the panel's main world.
 */

import { ipcRenderer } from 'electron';

const LEGACY_BRIDGE_CHANNEL = 'maestro:invokeCommand';
const REQUEST_CHANNEL = 'maestro:panel-request';
const SUBSCRIBE_CHANNEL = 'maestro:panel-subscribe';
const UNSUBSCRIBE_ALL_CHANNEL = 'maestro:panel-unsubscribe-all';
const INIT_CHANNEL = 'maestro:panel-init';
const RESULT_CHANNEL = 'maestro:panel-result';
const ERROR_CHANNEL = 'maestro:panel-error';
const EVENT_CHANNEL = 'maestro:panel-event';
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_REQUESTS_PER_SECOND = 120;
const ALLOWED_EVENT_TOPICS = new Set(['workspace.context']);

interface PanelMessageEvent {
	source: unknown;
	data: unknown;
}

interface PanelWindow {
	addEventListener(type: string, listener: (event: PanelMessageEvent) => void): void;
	postMessage(message: unknown, targetOrigin: string): void;
}

declare const window: PanelWindow;

let instanceId: string | null = null;
let requestWindowStart = 0;
let requestWindowCount = 0;
const pendingRequestIds = new Set<number>();
const subscribedTopics = new Set<string>();

function isOwnObject(data: unknown): data is Record<string, unknown> {
	return typeof data === 'object' && data !== null;
}

function hasBoundedJson(value: unknown): boolean {
	try {
		const json = JSON.stringify(value);
		let bytes = 0;
		for (let index = 0; index < json.length; index += 1) {
			const code = json.charCodeAt(index);
			if (code < 0x80) bytes += 1;
			else if (code < 0x800) bytes += 2;
			else if (code >= 0xd800 && code <= 0xdbff && index + 1 < json.length) {
				const next = json.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					bytes += 4;
					index += 1;
				} else bytes += 3;
			} else bytes += 3;
			if (bytes > MAX_PAYLOAD_BYTES) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function isCurrentInstance(value: unknown): value is string {
	return typeof value === 'string' && instanceId !== null && value === instanceId;
}

function resetInstance(nextInstanceId: string): void {
	instanceId = nextInstanceId;
	requestWindowStart = 0;
	requestWindowCount = 0;
	pendingRequestIds.clear();
	subscribedTopics.clear();
}

function postIntoPanel(payload: Record<string, unknown>): void {
	window.postMessage(payload, '*');
}

window.addEventListener('message', (event) => {
	if (event.source !== window || !isOwnObject(event.data)) return;
	const message = event.data;

	// Legacy panels keep exactly their one-way bridge contract.
	if (message.type === 'maestro:invokeCommand' && typeof message.commandId === 'string') {
		ipcRenderer.sendToHost(LEGACY_BRIDGE_CHANNEL, {
			commandId: message.commandId,
			args: message.args,
		});
		return;
	}

	if (message.type === 'maestro:panel-request') {
		const requestId = message.requestId;
		const payload = message.payload;
		if (
			!isCurrentInstance(message.instanceId) ||
			!Number.isSafeInteger(requestId) ||
			(requestId as number) < 1 ||
			message.method !== 'tool.invoke' ||
			!isOwnObject(payload) ||
			typeof payload.localId !== 'string' ||
			payload.localId.length === 0 ||
			payload.localId.length > 64 ||
			!hasBoundedJson(payload) ||
			pendingRequestIds.has(requestId as number) ||
			pendingRequestIds.size >= MAX_PENDING_REQUESTS
		) {
			return;
		}
		const now = Date.now();
		if (now - requestWindowStart >= 1000) {
			requestWindowStart = now;
			requestWindowCount = 0;
		}
		if (requestWindowCount >= MAX_REQUESTS_PER_SECOND) return;
		requestWindowCount += 1;
		pendingRequestIds.add(requestId as number);
		ipcRenderer.sendToHost(REQUEST_CHANNEL, {
			instanceId,
			requestId,
			method: 'tool.invoke',
			payload,
		});
		return;
	}

	if (message.type === 'maestro:panel-subscribe' || message.type === 'maestro:panel-unsubscribe') {
		if (!isCurrentInstance(message.instanceId) || typeof message.topic !== 'string') return;
		if (!ALLOWED_EVENT_TOPICS.has(message.topic)) return;
		if (message.type === 'maestro:panel-subscribe') {
			subscribedTopics.add(message.topic);
			ipcRenderer.sendToHost(SUBSCRIBE_CHANNEL, { instanceId, topic: message.topic });
		} else {
			subscribedTopics.delete(message.topic);
			ipcRenderer.sendToHost(UNSUBSCRIBE_ALL_CHANNEL, { instanceId, topic: message.topic });
		}
	}
});

window.addEventListener('unload', () => {
	if (instanceId !== null && subscribedTopics.size > 0) {
		ipcRenderer.sendToHost(UNSUBSCRIBE_ALL_CHANNEL, { instanceId });
	}
	pendingRequestIds.clear();
	subscribedTopics.clear();
	instanceId = null;
});

// Tests intentionally mock only the legacy sendToHost surface; the guard also
// makes the preload inert in non-Electron analysis environments.
if (typeof ipcRenderer.on === 'function') {
	ipcRenderer.on(INIT_CHANNEL, (_event, payload: unknown) => {
		if (!isOwnObject(payload)) return;
		if (
			typeof payload.instanceId !== 'string' ||
			payload.instanceId.length < 16 ||
			payload.instanceId.length > 128 ||
			!Number.isSafeInteger(payload.generation) ||
			(payload.generation as number) < 0
		) {
			return;
		}
		resetInstance(payload.instanceId);
		postIntoPanel({
			type: 'maestro:panel-init',
			instanceId: payload.instanceId,
			generation: payload.generation,
		});
	});

	ipcRenderer.on(RESULT_CHANNEL, (_event, payload: unknown) => {
		if (!isOwnObject(payload) || !isCurrentInstance(payload.instanceId)) return;
		if (
			!Number.isSafeInteger(payload.requestId) ||
			!pendingRequestIds.delete(payload.requestId as number)
		) {
			return;
		}
		if (!hasBoundedJson(payload.result)) return;
		postIntoPanel({
			type: 'maestro:panel-result',
			instanceId,
			requestId: payload.requestId,
			result: payload.result,
		});
	});

	ipcRenderer.on(ERROR_CHANNEL, (_event, payload: unknown) => {
		if (!isOwnObject(payload) || !isCurrentInstance(payload.instanceId)) return;
		if (
			!Number.isSafeInteger(payload.requestId) ||
			!pendingRequestIds.delete(payload.requestId as number) ||
			typeof payload.error !== 'string' ||
			payload.error.length > 1024
		) {
			return;
		}
		postIntoPanel({
			type: 'maestro:panel-error',
			instanceId,
			requestId: payload.requestId,
			error: payload.error,
		});
	});

	ipcRenderer.on(EVENT_CHANNEL, (_event, payload: unknown) => {
		if (!isOwnObject(payload) || !isCurrentInstance(payload.instanceId)) return;
		if (typeof payload.topic !== 'string' || !subscribedTopics.has(payload.topic)) return;
		if (!hasBoundedJson(payload.payload)) return;
		postIntoPanel({
			type: 'maestro:panel-event',
			instanceId,
			topic: payload.topic,
			payload: payload.payload,
		});
	});
}
