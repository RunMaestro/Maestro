import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../main/permission-relay/types';

const { mockSetOnRequest } = vi.hoisted(() => ({ mockSetOnRequest: vi.fn() }));

vi.mock('../../../main/permission-relay/PermissionRelayServer', () => ({
	permissionRelayServer: {
		setOnRequest: mockSetOnRequest,
	},
}));

import {
	initPermissionRelay,
	PERMISSION_REQUEST_CHANNEL,
} from '../../../main/permission-relay/integration';

describe('permission relay renderer integration', () => {
	it('forwards every notification field without exposing the relay token', () => {
		const send = vi.fn();
		const request: PermissionRequest = {
			requestId: 'request-1',
			token: 'secret-relay-token',
			sessionId: 'session-1',
			tabId: 'tab-1',
			toolName: 'Bash',
			input: { command: 'bun test' },
			createdAt: 123,
		};
		const window = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send,
			},
		};

		initPermissionRelay(() => window as never, null);

		const onRequest = mockSetOnRequest.mock.calls[0][0] as (request: PermissionRequest) => void;
		onRequest(request);

		expect(send).toHaveBeenCalledWith(PERMISSION_REQUEST_CHANNEL, {
			requestId: 'request-1',
			sessionId: 'session-1',
			tabId: 'tab-1',
			toolName: 'Bash',
			input: { command: 'bun test' },
			createdAt: 123,
		});
		expect(send.mock.calls[0][1]).not.toHaveProperty('token');
	});
});
