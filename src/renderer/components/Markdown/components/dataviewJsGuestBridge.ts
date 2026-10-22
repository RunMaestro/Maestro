/**
 * dataviewJsGuestBridge - the host half of the DataviewJS sandbox bridge that every guest host shares (D4, DEV-5):
 * `DataviewJsFrame` (one visible guest per `dataviewjs` fence) and `DataviewJsInlineHost` (one hidden guest per
 * note for its inline `$=` spans).
 *
 * - The structural types of the `<webview>` element and the events these hosts read from it.
 * - {@link pushToGuest}: a send that survives a guest that is gone or not attached yet.
 * - {@link createGuestRequestQueue}: `query.dql` and `io.load` answered only while the run that asked is in
 *   flight, at most {@link DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT} at a time, the rest refused when the run ends.
 * - {@link answerGuestRequest}: the answers themselves, through the executor DQL blocks use and main's
 *   `readInRoot`, which checks the path again (realpath containment, trust).
 * - {@link useDataviewJsSnapshot}: the index snapshot of the note, fetched while the host holds a guest slot and
 *   again (debounced) on every `dataview:changed` event for its root.
 *
 * Each host still renders its own `<webview>` tag and arms its own watchdog, so the security guard
 * (`src/__tests__/main/dataview/sandbox-security.test.ts`) can read both from each host's source.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	SANDBOX_TO_GUEST_CHANNEL,
	type DataviewQueryResponse,
	type SandboxHostMessage,
	type SandboxIndexSnapshot,
	type SandboxIoLoadMessage,
	type SandboxQueryDqlMessage,
} from '../../../../shared/dataview';
import { joinPath } from '../../../../shared/formatters';
import { useDebouncedCallback } from '../../../hooks/utils/useThrottle';
import { DATAVIEW_REFRESH_DEBOUNCE_MS } from '../../../hooks/file/useLiveDataviewResult';
import { isDataviewChangeFor, subscribeDataviewChanges } from '../../../services/dataviewChanges';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { isDetachedWebviewError } from '../../../utils/webviewErrors';
import { captureException } from '../../../utils/sentry';
import type { DataviewDocumentScope } from './DataviewDocumentContext';

/** Requests a guest may have in flight at once. More wait in line, so a script cannot flood main. */
export const DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT = 4;

/** What the refusal of a request outside a run says to the script. */
export const NO_RUN_MESSAGE = 'DataviewJS answers requests only while a script runs.';

/** Chromium's code for a load that was cancelled rather than failed. */
export const ERR_ABORTED = -3;

/** The `<webview>` element surface the hosts use (structural; Electron's type is not in the renderer). */
export interface GuestWebviewElement extends HTMLElement {
	send(channel: string, ...args: unknown[]): void;
}

/** The `ipc-message` event the guest preload raises through `sendToHost`. */
export interface GuestIpcMessageEvent extends Event {
	channel?: string;
	args?: unknown[];
}

/** The `did-fail-load` event of a `<webview>`. */
export interface GuestLoadFailEvent extends Event {
	errorCode?: number;
	isMainFrame?: boolean;
}

/** The note's index snapshot as main answers it, with the root and host the guest partition is keyed by. */
export type DataviewJsSnapshot = DataviewQueryResponse<SandboxIndexSnapshot>;

/** Why a guest was stopped (a timeout or a crash) or never ran (a failed load). */
export type DataviewJsGuestFailure = 'timeout' | 'crashed' | 'loadFailed';

/** The text a host shows for a stopped guest. */
export function dataviewJsGuestFailureText(failure: DataviewJsGuestFailure): string {
	switch (failure) {
		case 'timeout':
			return `DataviewJS: the script did not finish within ${DATAVIEW_JS_RUN_TIMEOUT_MS / 1000} seconds, so it was stopped.`;
		case 'crashed':
			return 'DataviewJS: the sandbox stopped unexpectedly.';
		case 'loadFailed':
			return 'DataviewJS: the sandbox could not load.';
	}
}

export function requestFailed(requestId: string, message: string): SandboxHostMessage {
	return { type: 'request.failed', requestId, message };
}

/** Push one message into a guest. False when the guest is gone or not attached yet (expected races). */
export function pushToGuest(
	guest: GuestWebviewElement,
	channel: string,
	message: unknown
): boolean {
	try {
		guest.send(channel, message);
		return true;
	} catch (error) {
		if (!isDetachedWebviewError(error)) {
			captureException(error, { extra: { where: 'dataviewJsGuestBridge.pushToGuest', channel } });
		}
		return false;
	}
}

export interface GuestRequestQueue {
	/**
	 * Answer one request of `runId` when its turn comes, and send the answer to the guest that asked. With no
	 * run in flight (`runId` null) the request is refused at once.
	 */
	enqueue(
		runId: string | null,
		guest: GuestWebviewElement,
		requestId: string,
		answer: () => Promise<SandboxHostMessage>
	): void;
	/** The run ended: refuse what it still has waiting in line. */
	dropRun(runId: string): void;
}

interface QueuedRequest {
	runId: string;
	requestId: string;
	/** The guest that asked; the answer goes back to it alone. */
	guest: GuestWebviewElement;
	answer(): Promise<SandboxHostMessage>;
}

export function createGuestRequestQueue(): GuestRequestQueue {
	let active = 0;
	let queue: QueuedRequest[] = [];

	const drain = (): void => {
		while (active < DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT && queue.length > 0) {
			const request = queue.shift()!;
			active += 1;
			void request
				.answer()
				.catch((error: unknown) => requestFailed(request.requestId, ipcErrorMessage(error)))
				.then((reply) => {
					active -= 1;
					pushToGuest(request.guest, SANDBOX_TO_GUEST_CHANNEL, reply);
					drain();
				});
		}
	};

	return {
		enqueue(runId, guest, requestId, answer) {
			if (runId === null) {
				pushToGuest(guest, SANDBOX_TO_GUEST_CHANNEL, requestFailed(requestId, NO_RUN_MESSAGE));
				return;
			}
			queue.push({ runId, requestId, guest, answer });
			drain();
		},
		dropRun(runId) {
			const dropped = queue.filter((request) => request.runId === runId);
			queue = queue.filter((request) => request.runId !== runId);
			for (const request of dropped) {
				pushToGuest(
					request.guest,
					SANDBOX_TO_GUEST_CHANNEL,
					requestFailed(request.requestId, NO_RUN_MESSAGE)
				);
			}
		},
	};
}

/**
 * The answer to a guest's `query.dql` (through `window.maestro.dataview.query`, `this` bound to `originPath` in
 * the snapshot's root, or the note) or `io.load` (through `window.maestro.dataview.readInRoot`).
 */
export async function answerGuestRequest(
	doc: DataviewDocumentScope,
	snapshot: DataviewJsSnapshot | null,
	message: SandboxQueryDqlMessage | SandboxIoLoadMessage
): Promise<SandboxHostMessage> {
	if (message.type === 'query.dql') {
		const filePath =
			snapshot && message.originPath ? joinPath(snapshot.root, message.originPath) : doc.filePath;
		const response = await window.maestro.dataview.query({
			filePath,
			source: message.source,
			agentId: doc.agentId,
		});
		return { type: 'query.dql.result', requestId: message.requestId, result: response.result };
	}
	const response = await window.maestro.dataview.readInRoot({
		filePath: doc.filePath,
		agentId: doc.agentId,
		path: message.path,
	});
	return { type: 'io.load.result', requestId: message.requestId, text: response.text };
}

export interface DataviewJsSnapshotState {
	/** The snapshot the guest runs against; null while loading, while inactive, and after a refusal. */
	snapshot: DataviewJsSnapshot | null;
	/** Main's text when it refused the snapshot (DataviewJS off, the vault not trusted) or the fetch failed. */
	error: string | null;
	/** The snapshot as of now, for event handlers that must not wait for a render. */
	snapshotRef: MutableRefObject<DataviewJsSnapshot | null>;
}

/**
 * The note's index snapshot (`dataview:jsSnapshot`), fetched while `active` (the host holds a guest slot) and
 * again, debounced like DQL blocks, on every `dataview:changed` event for the snapshot's root and host. Going
 * inactive drops the snapshot and ignores an answer still on its way.
 */
export function useDataviewJsSnapshot(
	doc: Pick<DataviewDocumentScope, 'filePath' | 'agentId'>,
	active: boolean
): DataviewJsSnapshotState {
	const [snapshot, setSnapshot] = useState<DataviewJsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const snapshotRef = useRef(snapshot);
	snapshotRef.current = snapshot;
	const generationRef = useRef(0);

	const load = useCallback(async () => {
		const generation = ++generationRef.current;
		try {
			const next = await window.maestro.dataview.jsSnapshot({
				filePath: doc.filePath,
				agentId: doc.agentId,
			});
			if (generation !== generationRef.current) return;
			setSnapshot(next);
			setError(null);
		} catch (failure) {
			if (generation !== generationRef.current) return;
			// Main refused or failed: the guest goes too, so nothing runs on the snapshot it still holds.
			setSnapshot(null);
			setError(ipcErrorMessage(failure));
		}
	}, [doc.filePath, doc.agentId]);

	useEffect(() => {
		if (active) {
			void load();
			return;
		}
		generationRef.current++;
		setSnapshot(null);
	}, [active, load]);

	const { debouncedCallback: scheduleReload } = useDebouncedCallback(() => {
		void load();
	}, DATAVIEW_REFRESH_DEBOUNCE_MS);

	useEffect(
		() =>
			subscribeDataviewChanges((event) => {
				const shown = snapshotRef.current;
				if (shown && isDataviewChangeFor(event, shown)) scheduleReload();
			}),
		[scheduleReload]
	);

	return { snapshot, error, snapshotRef };
}
