/**
 * Renderer-side registry for live Concerto HTML frames. It records diagnostics
 * posted by the sandbox bootstrap and exposes the narrow inspect/interact API
 * used by the main-process request bridge.
 */

import {
	CONCERTO_DESIGNER_CHANNEL,
	type ConcertoDesignerAction,
	type ConcertoDesignerActionResult,
	type ConcertoDesignerFrameSnapshot,
	type ConcertoDesignerLogEntry,
	type ConcertoDesignerLogLevel,
	type ConcertoHtmlSurface,
} from '../../../shared/concerto-html';

const MAX_LOG_ENTRIES = 100;
const DEFAULT_READY_TIMEOUT_MS = 2000;
const DEFAULT_ACTION_TIMEOUT_MS = 2000;

interface PendingAction {
	action: ConcertoDesignerAction;
	resolve: (result: ConcertoDesignerActionResult) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

interface FrameRecord {
	frame: HTMLIFrameElement;
	revision: number;
	ready: boolean;
	logs: ConcertoDesignerLogEntry[];
	pendingActions: Map<string, PendingAction>;
}

const records = new Map<string, FrameRecord>();
const recordWaiters = new Map<string, Set<() => void>>();
let nextRequestId = 1;

function frameKey(surface: ConcertoHtmlSurface, id: string): string {
	return `${surface}\0${id}`;
}

function notifyRecordWaiters(key: string): void {
	const waiters = recordWaiters.get(key);
	if (!waiters) return;
	for (const resolve of waiters) resolve();
	waiters.clear();
	recordWaiters.delete(key);
}

function notifyReady(key: string, record: FrameRecord): void {
	record.ready = true;
	notifyRecordWaiters(key);
}

function clearRecord(record: FrameRecord): void {
	for (const pending of record.pendingActions.values()) {
		clearTimeout(pending.timeoutId);
		pending.resolve({
			ok: false,
			action: pending.action.kind,
			selector: pending.action.selector,
			message: 'Mockup frame was removed before the action completed',
		});
	}
	record.pendingActions.clear();
}

export function registerConcertoDesignerFrame(
	surface: ConcertoHtmlSurface,
	id: string,
	revision: number,
	frame: HTMLIFrameElement
): void {
	const key = frameKey(surface, id);
	const previous = records.get(key);
	if (previous && previous.frame !== frame) clearRecord(previous);
	records.set(key, {
		frame,
		revision,
		ready: false,
		logs: [],
		pendingActions: new Map(),
	});
	notifyRecordWaiters(key);
}

export function unregisterConcertoDesignerFrame(
	surface: ConcertoHtmlSurface,
	id: string,
	frame: HTMLIFrameElement
): void {
	const key = frameKey(surface, id);
	const record = records.get(key);
	if (!record || record.frame !== frame) return;
	clearRecord(record);
	records.delete(key);
	notifyRecordWaiters(key);
}

function isLogLevel(value: unknown): value is ConcertoDesignerLogLevel {
	return value === 'log' || value === 'info' || value === 'warn' || value === 'error';
}

/** Accept a postMessage only from the exact registered iframe window. */
export function handleConcertoDesignerMessage(
	surface: ConcertoHtmlSurface,
	id: string,
	event: MessageEvent
): void {
	const key = frameKey(surface, id);
	const record = records.get(key);
	if (!record || event.source !== record.frame.contentWindow) return;
	const data = event.data as Record<string, unknown> | null;
	if (!data || data.channel !== CONCERTO_DESIGNER_CHANNEL) return;

	if (data.kind === 'ready') {
		notifyReady(key, record);
		return;
	}
	if (data.kind === 'console' && isLogLevel(data.level) && typeof data.message === 'string') {
		record.logs.push({
			level: data.level,
			message: data.message.slice(0, 4000),
			timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
			line: typeof data.line === 'number' ? data.line : undefined,
			column: typeof data.column === 'number' ? data.column : undefined,
		});
		if (record.logs.length > MAX_LOG_ENTRIES) {
			record.logs.splice(0, record.logs.length - MAX_LOG_ENTRIES);
		}
		return;
	}
	if (data.kind !== 'command-result' || typeof data.requestId !== 'string') return;
	const pending = record.pendingActions.get(data.requestId);
	if (!pending) return;
	clearTimeout(pending.timeoutId);
	record.pendingActions.delete(data.requestId);
	pending.resolve({
		ok: data.ok === true,
		action: data.action === 'type' ? 'type' : 'click',
		selector: typeof data.selector === 'string' ? data.selector : '',
		message: typeof data.message === 'string' ? data.message : 'Designer action completed',
		element:
			data.element && typeof data.element === 'object'
				? {
						tag: String((data.element as Record<string, unknown>).tag ?? ''),
						text: String((data.element as Record<string, unknown>).text ?? ''),
						ariaLabel:
							typeof (data.element as Record<string, unknown>).ariaLabel === 'string'
								? ((data.element as Record<string, unknown>).ariaLabel as string)
								: undefined,
					}
				: undefined,
	});
}

function isMatchingReadyRecord(
	record: FrameRecord | undefined,
	expectedRevision: number | undefined
): record is FrameRecord {
	return (
		record !== undefined &&
		record.frame.isConnected &&
		record.ready &&
		(expectedRevision === undefined || record.revision === expectedRevision)
	);
}

async function waitForMatchingReadyRecord(
	key: string,
	expectedRevision: number | undefined,
	timeoutMs: number
): Promise<FrameRecord | null> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (true) {
		const record = records.get(key);
		if (isMatchingReadyRecord(record, expectedRevision)) return record;

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return null;
		await new Promise<void>((resolve) => {
			let waiters = recordWaiters.get(key);
			if (!waiters) {
				waiters = new Set();
				recordWaiters.set(key, waiters);
			}
			const finish = () => {
				clearTimeout(timeoutId);
				waiters?.delete(finish);
				if (waiters?.size === 0) recordWaiters.delete(key);
				resolve();
			};
			const timeoutId = setTimeout(finish, remainingMs);
			waiters.add(finish);
		});
	}
}

export async function getConcertoDesignerFrameSnapshot(
	surface: ConcertoHtmlSurface,
	id: string,
	timeoutMs = DEFAULT_READY_TIMEOUT_MS,
	expectedRevision?: number
): Promise<ConcertoDesignerFrameSnapshot | null> {
	const record = await waitForMatchingReadyRecord(
		frameKey(surface, id),
		expectedRevision,
		timeoutMs
	);
	if (!record) return null;
	const rect = record.frame.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	return {
		id,
		ready: record.ready,
		revision: record.revision,
		rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		viewport: {
			width: record.frame.clientWidth || Math.round(rect.width),
			height: record.frame.clientHeight || Math.round(rect.height),
		},
		logs: [...record.logs],
	};
}

export async function interactWithConcertoDesignerFrame(
	surface: ConcertoHtmlSurface,
	id: string,
	action: ConcertoDesignerAction,
	timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	expectedRevision?: number
): Promise<ConcertoDesignerActionResult> {
	const startedAt = Date.now();
	const record = await waitForMatchingReadyRecord(
		frameKey(surface, id),
		expectedRevision,
		timeoutMs
	);
	if (!record || !record.frame.contentWindow) {
		return {
			ok: false,
			action: action.kind,
			selector: action.selector,
			message: `HTML ${surface} '${id}' is not visible`,
		};
	}
	const actionTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
	const requestId = `designer-${Date.now()}-${nextRequestId++}`;
	return new Promise<ConcertoDesignerActionResult>((resolve) => {
		const timeoutId = setTimeout(() => {
			record.pendingActions.delete(requestId);
			resolve({
				ok: false,
				action: action.kind,
				selector: action.selector,
				message: 'Designer action timed out',
			});
		}, actionTimeoutMs);
		record.pendingActions.set(requestId, { action, resolve, timeoutId });
		record.frame.contentWindow?.postMessage(
			{
				channel: CONCERTO_DESIGNER_CHANNEL,
				kind: 'command',
				requestId,
				action: action.kind,
				selector: action.selector,
				...(action.kind === 'type' ? { value: action.value } : {}),
			},
			'*'
		);
	});
}

/** Test-only reset for singleton renderer state. */
export function clearConcertoDesignerFramesForTests(): void {
	for (const record of records.values()) clearRecord(record);
	records.clear();
	for (const waiters of recordWaiters.values()) {
		for (const resolve of waiters) resolve();
		waiters.clear();
	}
	recordWaiters.clear();
}
