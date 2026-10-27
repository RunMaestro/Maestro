import { create } from 'zustand';
import type {
	HarnessInteractionRequest,
	HarnessInteractionResponse,
	HarnessInteractionSettledEvent,
} from '../../shared/harness-control/types';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';

/** Expected transport loss is not a Sentry event; all other failures remain reportable. */
function isExpectedConnectionFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /No ipcMain handler registered|not connected|connection (?:is )?(?:closed|lost)|ECONNREFUSED|WebSocket|destroyed|disposed/i.test(
		message
	);
}

/** Log expected disconnects locally and capture unexpected broker/IPC failures. */
function reportInteractionFailure(error: unknown, operation: string, requestId?: string): void {
	if (isExpectedConnectionFailure(error)) {
		logger.warn(`[harnessInteractionStore] ${operation} unavailable`, undefined, error);
		return;
	}
	captureException(error, { extra: { operation, requestId } });
}

interface HarnessInteractionState {
	queue: HarnessInteractionRequest[];
	responding: Record<string, true>;
	settledIds: Record<string, true>;
	enqueue: (request: HarnessInteractionRequest) => void;
	settle: (event: Pick<HarnessInteractionSettledEvent, 'requestId'>) => void;
	clearSession: (sessionId: string) => void;
	loadPending: () => Promise<void>;
	respond: (response: HarnessInteractionResponse) => Promise<void>;
}

export const useHarnessInteractionStore = create<HarnessInteractionState>((set, get) => ({
	queue: [],
	settledIds: {},
	responding: {},
	enqueue: (request) =>
		set((state) => {
			if (state.settledIds[request.requestId]) return state;
			if (state.queue.some((item) => item.requestId === request.requestId)) return state;
			return { queue: [...state.queue, request] };
		}),
	settle: ({ requestId }) =>
		set((state) => {
			const settledIds: Record<string, true> = { ...state.settledIds, [requestId]: true };
			if (Object.keys(settledIds).length > 1000) {
				delete settledIds[Object.keys(settledIds)[0]];
			}
			return {
				queue: state.queue.filter((item) => item.requestId !== requestId),
				settledIds,
			};
		}),
	clearSession: (sessionId) =>
		set((state) => ({ queue: state.queue.filter((item) => item.sessionId !== sessionId) })),
	loadPending: async () => {
		const api = window.maestro?.process;
		if (!api?.listHarnessInteractions) return;
		try {
			const pending = await api.listHarnessInteractions();
			for (const request of pending) get().enqueue(request);
		} catch (error) {
			reportInteractionFailure(error, 'restore-pending-interactions');
		}
	},
	respond: async (response) => {
		const requestId = response.requestId;
		if (get().responding[requestId]) return;
		const api = window.maestro?.process;
		if (!api?.respondHarnessInteraction) return;
		set((state) => ({ responding: { ...state.responding, [requestId]: true } }));
		try {
			const result = await api.respondHarnessInteraction(response);
			if (result === 'resolved' || result === 'not-found') {
				get().settle({ requestId });
			}
		} catch (error) {
			reportInteractionFailure(error, 'respond-interaction', requestId);
		} finally {
			set((state) => {
				const responding = { ...state.responding };
				delete responding[requestId];
				return { responding };
			});
		}
	},
}));

/** Select the oldest unanswered interaction so requests settle in arrival order. */
export function selectActiveHarnessInteraction(
	state: HarnessInteractionState
): HarnessInteractionRequest | undefined {
	return state.queue[0];
}
