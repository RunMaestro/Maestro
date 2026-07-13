import type { OmpPanelEventKind, OmpPanelRequestKind } from '../bridge/descriptor';
import type { OmpWorkspaceAdapter, OmpWorkspaceSnapshot } from './types';

export type { OmpPanelEventKind, OmpPanelRequestKind } from '../bridge/descriptor';

export interface OmpPanelResult {
	readonly kind: OmpPanelRequestKind;
	readonly requestId: string;
	readonly payload: unknown;
}

export interface OmpPanelEvent {
	readonly kind: OmpPanelEventKind;
	readonly eventSequence: bigint;
	readonly payload: unknown;
}

/** The panel's generation-capability-bound API; it never exposes raw runtime frames. */
export interface OmpPanelPort {
	request(kind: OmpPanelRequestKind, payload: Record<string, unknown>): Promise<OmpPanelResult>;
	subscribe(kind: OmpPanelEventKind, listener: (event: OmpPanelEvent) => void): () => void;
}

export class OmpPanelCapabilityUnavailableError extends Error {
	readonly code = 'capability_unavailable';

	constructor(control: string) {
		super(`OMP control ${control} is unavailable in this runtime.`);
		this.name = 'OmpPanelCapabilityUnavailableError';
	}
}

export interface OmpPanelControllerAdapter {
	request(kind: OmpPanelRequestKind, payload: Record<string, unknown>): Promise<unknown>;
	subscribe(kind: OmpPanelEventKind, listener: (payload: unknown) => void): () => void;
}

function isWorkspaceSnapshot(value: unknown): value is OmpWorkspaceSnapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const snapshot = value as Record<string, unknown>;
	return (
		(snapshot.connection === 'loading' ||
			snapshot.connection === 'ready' ||
			snapshot.connection === 'offline' ||
			snapshot.connection === 'incompatible' ||
			snapshot.connection === 'error') &&
		Array.isArray(snapshot.models) &&
		Array.isArray(snapshot.sessions) &&
		(typeof snapshot.activeSessionId === 'string' || snapshot.activeSessionId === null)
	);
}

async function request(
	port: OmpPanelPort,
	kind: OmpPanelRequestKind,
	payload: Record<string, unknown>
): Promise<unknown> {
	const result = await port.request(kind, payload);
	if (result.kind !== kind) throw new Error(`OMP panel received ${result.kind} for ${kind}.`);
	return result.payload;
}

/** Exposes all frozen named controls while keeping presentation callers off a generic transport. */
export function createOmpPanelControllerAdapter(port: OmpPanelPort): OmpPanelControllerAdapter {
	return {
		request: (kind, payload) => request(port, kind, payload),
		subscribe: (kind, listener) => port.subscribe(kind, (event) => listener(event.payload)),
	};
}

/**
 * Compatibility view used by the current presentation tree. Legacy UI concepts that
 * have no §4.2 command intentionally reject with a typed visible-unavailable error.
 */
const MAX_ATTACHMENT_BYTES_PER_FILE = 128 * 1024;
const MAX_ATTACHMENT_WIRE_BYTES = 512 * 1024;

/**
 * Compatibility view used by the current presentation tree. All mutations remain
 * named, descriptor-validated requests; only presentation deltas are reduced locally.
 */
export function createOmpWorkspaceAdapter(port: OmpPanelPort): OmpWorkspaceAdapter {
	const controller = createOmpPanelControllerAdapter(port);
	let currentSnapshot: OmpWorkspaceSnapshot | null = null;

	return {
		async getSnapshot() {
			const payload = await controller.request('omp.commands.refresh', {});
			if (!isWorkspaceSnapshot(payload))
				throw new Error('OMP returned an invalid workspace projection.');
			currentSnapshot = payload;
			return payload;
		},
		subscribe(listener) {
			const publish = (next: OmpWorkspaceSnapshot) => {
				currentSnapshot = next;
				listener(next);
			};
			const unsubscribeView = controller.subscribe('omp.view.replace', (payload) => {
				if (isWorkspaceSnapshot(payload)) publish(payload);
			});
			const unsubscribeDelta = controller.subscribe('omp.stream.delta', (payload) => {
				if (!currentSnapshot || !isStreamDelta(payload)) return;
				publish(reduceStreamDelta(currentSnapshot, payload));
			});
			const unsubscribeApproval = controller.subscribe('omp.approval.required', (payload) => {
				if (!currentSnapshot || !isApprovalRequired(payload)) return;
				publish(reduceApprovalRequired(currentSnapshot, payload));
			});
			return () => {
				unsubscribeView();
				unsubscribeDelta();
				unsubscribeApproval();
			};
		},
		async selectSession(sessionId) {
			await controller.request('omp.session.select', { sessionId });
		},
		async createSession() {
			await controller.request('omp.session.create', {});
		},
		async sendMessage(sessionId, text, attachments) {
			await controller.request('omp.prompt.send', {
				sessionId,
				text,
				attachments: await encodeAttachments(attachments),
			});
		},
		async abort(sessionId) {
			await controller.request('omp.run.abort', { sessionId });
		},
		async setModel(sessionId, model) {
			const separator = model.indexOf('/');
			if (separator <= 0 || separator === model.length - 1)
				throw new OmpPanelCapabilityUnavailableError('omp.model.set');
			await controller.request('omp.model.set', {
				sessionId,
				provider: model.slice(0, separator),
				modelId: model.slice(separator + 1),
			});
		},
		async setThinkingLevel(sessionId, level) {
			await controller.request('omp.thinking.set', { sessionId, level });
		},
		async setMode(sessionId, mode) {
			await controller.request('omp.composer.mode.set', { sessionId, mode });
		},
		async resolveApproval(sessionId, requestId, approved) {
			await controller.request('omp.approval.resolve', { sessionId, requestId, approved });
		},
		async retry() {
			await controller.request('omp.commands.refresh', {});
		},
	};
}

function isStreamDelta(payload: unknown): payload is { sessionId: string; delta: string } {
	return (
		!!payload &&
		typeof payload === 'object' &&
		typeof (payload as Record<string, unknown>).sessionId === 'string' &&
		typeof (payload as Record<string, unknown>).delta === 'string'
	);
}

function isApprovalRequired(
	payload: unknown
): payload is { sessionId: string; requestId: string; description?: string } {
	return (
		!!payload &&
		typeof payload === 'object' &&
		typeof (payload as Record<string, unknown>).sessionId === 'string' &&
		typeof (payload as Record<string, unknown>).requestId === 'string' &&
		(typeof (payload as Record<string, unknown>).description === 'undefined' ||
			typeof (payload as Record<string, unknown>).description === 'string')
	);
}

function reduceStreamDelta(
	snapshot: OmpWorkspaceSnapshot,
	payload: { sessionId: string; delta: string }
): OmpWorkspaceSnapshot {
	return updateSession(snapshot, payload.sessionId, (session) => {
		const eventId = `stream:${payload.sessionId}`;
		const existing = session.events.find((event) => event.id === eventId);
		const events = existing
			? session.events.map((event) =>
					event.id === eventId && event.kind === 'assistant'
						? { ...event, text: event.text + payload.delta }
						: event
				)
			: [...session.events, { id: eventId, kind: 'assistant' as const, text: payload.delta }];
		return { ...session, status: 'streaming', events };
	});
}

function reduceApprovalRequired(
	snapshot: OmpWorkspaceSnapshot,
	payload: { sessionId: string; requestId: string; description?: string }
): OmpWorkspaceSnapshot {
	return updateSession(snapshot, payload.sessionId, (session) => {
		const eventId = `approval:${payload.requestId}`;
		if (session.events.some((event) => event.id === eventId))
			return { ...session, status: 'waiting-approval' };
		return {
			...session,
			status: 'waiting-approval',
			events: [
				...session.events,
				{
					id: eventId,
					kind: 'approval',
					requestId: payload.requestId,
					description: payload.description ?? 'OMP requires approval.',
				},
			],
		};
	});
}

function updateSession(
	snapshot: OmpWorkspaceSnapshot,
	sessionId: string,
	update: (
		session: OmpWorkspaceSnapshot['sessions'][number]
	) => OmpWorkspaceSnapshot['sessions'][number]
): OmpWorkspaceSnapshot {
	return {
		...snapshot,
		sessions: snapshot.sessions.map((session) =>
			session.id === sessionId ? update(session) : session
		),
	};
}

async function encodeAttachments(
	attachments: readonly File[]
): Promise<readonly { name: string; mediaType: string; size: number; dataBase64: string }[]> {
	let wireBytes = 0;
	for (const attachment of attachments) {
		if (
			attachment.size < 1 ||
			!Number.isInteger(attachment.size) ||
			attachment.size > MAX_ATTACHMENT_BYTES_PER_FILE
		)
			throw new Error(`Attachment ${attachment.name} exceeds the per-file size limit.`);
		wireBytes += attachment.size + Math.ceil(attachment.size / 3) * 4;
		if (wireBytes > MAX_ATTACHMENT_WIRE_BYTES)
			throw new Error('Attachments exceed the total size limit.');
	}
	return Promise.all(
		attachments.map(async (attachment) => {
			const mediaType = attachment.type || 'application/octet-stream';
			if (
				attachment.name.length === 0 ||
				attachment.name.length > 255 ||
				attachment.name.includes('/') ||
				attachment.name.includes('\\') ||
				[...attachment.name].some((character) => character.charCodeAt(0) < 32) ||
				!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mediaType)
			)
				throw new Error(
					`Attachment ${attachment.name || '(unnamed)'} has an invalid name or media type.`
				);
			const dataBase64 = encodeBase64(new Uint8Array(await attachment.arrayBuffer()));
			return { name: attachment.name, mediaType, size: attachment.size, dataBase64 };
		})
	);
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
