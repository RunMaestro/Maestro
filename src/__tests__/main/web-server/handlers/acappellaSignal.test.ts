/**
 * @file acappellaSignal.test.ts
 *
 * The WebSocket adapter that carries A Cappella signaling.
 *
 * Contracts defended:
 * - A frame arriving with no transport, or with the Encore Feature switched off,
 *   gets a STATED refusal. A phone that gets no answer cannot tell "the feature is
 *   off" from "the network ate it", and only one of those is worth retrying.
 * - Feature-off is checked separately from transport-absent. The transport is
 *   built once at boot and deliberately kept alive so the feature can be switched
 *   back on without a restart, so "a transport exists" does NOT mean "the feature
 *   is on" - and a device that was already connected when the user unticked the
 *   box would otherwise keep signaling into a live transport.
 * - Registration is lazy and idempotent, and a refused frame registers nothing:
 *   a browser client that never speaks A Cappella must not cost a signaling
 *   session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const transportRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../../main/acappella', () => ({
	getACappellaTransport: () => transportRef.current,
}));

import {
	ACAPPELLA_SIGNAL_MESSAGE,
	handleACappellaSignal,
	handleACappellaSignalDisconnect,
} from '../../../../main/web-server/handlers/messageHandlers/acappellaSignal';
import type {
	MessageHandlerContext,
	WebClient,
	WebClientMessage,
} from '../../../../main/web-server/handlers/messageHandlers/types';

interface FakeTransport {
	featureEnabled: () => boolean;
	registerClient: ReturnType<typeof vi.fn>;
	handleSignalMessage: ReturnType<typeof vi.fn>;
	handleClientDisconnect: ReturnType<typeof vi.fn>;
}

let sent: Array<Record<string, unknown>>;
let transport: FakeTransport;
let enabled: boolean;

const client = { id: 'client-1' } as unknown as WebClient;

const ctx = {
	send: (_client: WebClient, data: Record<string, unknown>) => sent.push(data),
} as unknown as MessageHandlerContext;

const frame = {
	type: ACAPPELLA_SIGNAL_MESSAGE,
	payload: { op: 'auth', deviceId: 'device-1', token: 'secret' },
} as unknown as WebClientMessage;

/** The refusal both gated branches share. */
function expectRefusal(): void {
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({
		type: ACAPPELLA_SIGNAL_MESSAGE,
		payload: {
			op: 'error',
			code: 'not-authenticated',
			message: expect.stringContaining('Encore Features'),
		},
	});
}

beforeEach(() => {
	sent = [];
	enabled = true;
	transport = {
		featureEnabled: () => enabled,
		registerClient: vi.fn(),
		handleSignalMessage: vi.fn().mockResolvedValue(undefined),
		handleClientDisconnect: vi.fn(),
	};
	transportRef.current = transport;
});

describe('handleACappellaSignal', () => {
	it('registers the client and hands over the payload when the feature is on', () => {
		handleACappellaSignal(ctx, client, frame);

		expect(transport.registerClient).toHaveBeenCalledWith(
			expect.objectContaining({ clientId: 'client-1' })
		);
		expect(transport.handleSignalMessage).toHaveBeenCalledWith('client-1', {
			op: 'auth',
			deviceId: 'device-1',
			token: 'secret',
		});
		expect(sent).toEqual([]);
	});

	it('writes back through the socket it was given', () => {
		handleACappellaSignal(ctx, client, frame);

		const [params] = transport.registerClient.mock.calls[0] as [
			{ send: (message: unknown) => void },
		];
		params.send({ op: 'authenticated', deviceId: 'device-1' });

		expect(sent[0]).toEqual({
			type: ACAPPELLA_SIGNAL_MESSAGE,
			payload: { op: 'authenticated', deviceId: 'device-1' },
		});
	});

	it('refuses in a sentence when no transport has ever been built', () => {
		transportRef.current = null;

		handleACappellaSignal(ctx, client, frame);

		expectRefusal();
	});

	it('refuses while the Encore Feature is off, even with a live transport', () => {
		// The regression this exists for: switching the feature off used to leave the
		// transport serving, so a phone that was connected at the moment of the
		// toggle kept holding a signaling session against a desktop whose owner
		// believed voice was off.
		enabled = false;

		handleACappellaSignal(ctx, client, frame);

		expectRefusal();
		expect(transport.registerClient).not.toHaveBeenCalled();
		expect(transport.handleSignalMessage).not.toHaveBeenCalled();
	});

	it('serves again once the feature comes back on, with no restart', () => {
		enabled = false;
		handleACappellaSignal(ctx, client, frame);
		enabled = true;
		handleACappellaSignal(ctx, client, frame);

		expect(transport.handleSignalMessage).toHaveBeenCalledTimes(1);
	});
});

describe('handleACappellaSignalDisconnect', () => {
	it('tears down the signaling session for a socket that went away', () => {
		handleACappellaSignalDisconnect('client-1');

		expect(transport.handleClientDisconnect).toHaveBeenCalledWith('client-1');
	});

	it('is a no-op with no transport', () => {
		transportRef.current = null;

		expect(() => handleACappellaSignalDisconnect('client-1')).not.toThrow();
	});
});
