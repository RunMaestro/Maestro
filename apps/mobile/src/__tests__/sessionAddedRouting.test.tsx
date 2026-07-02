/**
 * Regression test for the "new desktop agents don't appear in the mobile
 * sidebar" bug.
 *
 * Root cause: the desktop broadcasts incremental `session_added` /
 * `session_removed` messages when an agent is created or removed (it does NOT
 * resend the full `sessions_list`). The mobile WebSocket message router had no
 * cases for those types, so they were silently dropped and the sidebar stayed
 * frozen at whatever existed when the socket connected.
 *
 * These tests drive real frames through `useMaestroWebSocket`'s message handler
 * and assert the corresponding handler fires - exercising the exact switch that
 * was missing the cases.
 */

import { act, renderHook } from '@testing-library/react-native';

import { useMaestroWebSocket, type SessionData } from '../lib/useMaestroWebSocket';

// Provide a deterministic WebSocket URL so connect() proceeds past the
// credentials check without touching SecureStore.
jest.mock('../../shims/config', () => ({
	buildWebSocketUrl: jest.fn(async () => 'ws://localhost:1234/token/ws'),
	hasCredentials: jest.fn(async () => true),
}));

// Minimal fake WebSocket that captures the latest instance so a test can push
// frames through the hook's `onmessage` handler.
let lastSocket: FakeWebSocket | null = null;

class FakeWebSocket {
	static readonly OPEN = 1;
	readyState = FakeWebSocket.OPEN;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;

	constructor(public url: string) {
		lastSocket = this;
	}

	send = jest.fn();
	close = jest.fn();

	/** Helper: deliver a parsed message as if it came from the server. */
	emit(message: object): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
}

const sampleSession: SessionData = {
	id: 'agent-new',
	name: 'Fresh Agent',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/tmp/project',
};

async function connectAndAuthenticate() {
	const onSessionsUpdate = jest.fn();
	const onSessionAdded = jest.fn();
	const onSessionRemoved = jest.fn();

	// renderHook is async in @testing-library/react-native v14 and populates
	// result.current via a useEffect, so it must be awaited.
	const { result } = await renderHook(() =>
		useMaestroWebSocket({
			autoReconnect: false,
			handlers: { onSessionsUpdate, onSessionAdded, onSessionRemoved },
		})
	);

	// connect() awaits buildWebSocketUrl(), so flush microtasks before the
	// fake socket is wired up.
	await act(async () => {
		result.current.connect();
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(lastSocket).not.toBeNull();

	await act(async () => {
		lastSocket!.onopen?.();
		lastSocket!.emit({ type: 'connected', authenticated: true });
	});

	return { onSessionsUpdate, onSessionAdded, onSessionRemoved };
}

describe('useMaestroWebSocket incremental session routing', () => {
	beforeEach(() => {
		lastSocket = null;
		(global as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
	});

	it('routes session_added to onSessionAdded (the bug: this was dropped)', async () => {
		const { onSessionAdded } = await connectAndAuthenticate();

		await act(async () => {
			lastSocket!.emit({ type: 'session_added', session: sampleSession });
		});

		expect(onSessionAdded).toHaveBeenCalledTimes(1);
		expect(onSessionAdded).toHaveBeenCalledWith(sampleSession);
	});

	it('routes session_removed to onSessionRemoved', async () => {
		const { onSessionRemoved } = await connectAndAuthenticate();

		await act(async () => {
			lastSocket!.emit({ type: 'session_removed', sessionId: 'agent-gone' });
		});

		expect(onSessionRemoved).toHaveBeenCalledTimes(1);
		expect(onSessionRemoved).toHaveBeenCalledWith('agent-gone');
	});
});
