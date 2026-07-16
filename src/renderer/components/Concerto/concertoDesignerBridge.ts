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
	readyWaiters: Set<() => void>;
	pendingActions: Map<string, PendingAction>;
}

const records = new Map<string, FrameRecord>();
let nextRequestId = 1;

function frameKey(surface: ConcertoHtmlSurface, id: string): string {
	return `${surface}\0${id}`;
}

function notifyReady(record: FrameRecord): void {
	record.ready = true;
	for (const resolve of record.readyWaiters) resolve();
	record.readyWaiters.clear();
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
	for (const resolve of record.readyWaiters) resolve();
	record.readyWaiters.clear();
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
		readyWaiters: new Set(),
		pendingActions: new Map(),
	});
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
	const record = records.get(frameKey(surface, id));
	if (!record || event.source !== record.frame.contentWindow) return;
	const data = event.data as Record<string, unknown> | null;
	if (!data || data.channel !== CONCERTO_DESIGNER_CHANNEL) return;

	if (data.kind === 'ready') {
		notifyReady(record);
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

async function waitForReady(record: FrameRecord, timeoutMs: number): Promise<void> {
	if (record.ready) return;
	await new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timeoutId);
			record.readyWaiters.delete(finish);
			resolve();
		};
		const timeoutId = setTimeout(finish, timeoutMs);
		record.readyWaiters.add(finish);
	});
}

export async function getConcertoDesignerFrameSnapshot(
	surface: ConcertoHtmlSurface,
	id: string,
	timeoutMs = DEFAULT_READY_TIMEOUT_MS
): Promise<ConcertoDesignerFrameSnapshot | null> {
	const record = records.get(frameKey(surface, id));
	if (!record || !record.frame.isConnected) return null;
	await waitForReady(record, timeoutMs);
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
	timeoutMs = DEFAULT_ACTION_TIMEOUT_MS
): Promise<ConcertoDesignerActionResult> {
	const record = records.get(frameKey(surface, id));
	if (!record || !record.frame.isConnected || !record.frame.contentWindow) {
		return {
			ok: false,
			action: action.kind,
			selector: action.selector,
			message: `HTML ${surface} '${id}' is not visible`,
		};
	}
	await waitForReady(record, DEFAULT_READY_TIMEOUT_MS);
	if (!record.ready) {
		return {
			ok: false,
			action: action.kind,
			selector: action.selector,
			message: `HTML ${surface} '${id}' did not finish loading`,
		};
	}
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
		}, timeoutMs);
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
}
