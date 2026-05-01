import type { BrowserWindow } from 'electron';
import type {
	WorkGraphBroadcastEnvelope,
	WorkGraphBroadcastOperation,
} from '../../shared/work-graph-types';
import { isWebContentsAvailable } from '../utils/safe-send';

let sequence = 0;
let webBroadcaster: ((envelope: WorkGraphBroadcastEnvelope) => void) | null = null;
const subscribers = new Set<(envelope: WorkGraphBroadcastEnvelope) => void>();

export function setWorkGraphWebBroadcaster(
	broadcaster: ((envelope: WorkGraphBroadcastEnvelope) => void) | null
): void {
	webBroadcaster = broadcaster;
}

export function subscribeWorkGraphEvents(
	subscriber: (envelope: WorkGraphBroadcastEnvelope) => void
): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

export function publishWorkGraphEvent(
	getMainWindow: () => BrowserWindow | null,
	operation: WorkGraphBroadcastOperation,
	payload: unknown
): WorkGraphBroadcastEnvelope {
	const envelope: WorkGraphBroadcastEnvelope = {
		type: 'workGraph',
		operation,
		sequence: ++sequence,
		timestamp: new Date().toISOString(),
		payload,
	};

	const mainWindow = getMainWindow();
	if (isWebContentsAvailable(mainWindow)) {
		mainWindow.webContents.send('workGraph:changed', envelope);
	}

	webBroadcaster?.(envelope);
	for (const subscriber of subscribers) {
		subscriber(envelope);
	}

	return envelope;
}
