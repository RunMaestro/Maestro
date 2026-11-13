import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheck = vi.fn();
const mockList = vi.fn();
vi.mock('../../../../main/ssh-reachability', () => ({
	checkSshRemote: (...args: unknown[]) => mockCheck(...args),
	getUnreachableSshRemotes: () => mockList(),
}));

import {
	handleSshReachabilityCheck,
	handleSshReachabilityStatus,
} from '../../../../main/web-server/handlers/messageHandlers/sshReachability';
import type {
	MessageHandlerContext,
	WebClient,
} from '../../../../main/web-server/handlers/messageHandlers/types';

const outage = {
	remoteId: 'r1',
	remoteName: 'pedtome',
	reachable: false,
	message: 'Unable to connect to "pedtome" over SSH.',
	since: 1,
};

describe('ssh reachability WS handlers', () => {
	let send: ReturnType<typeof vi.fn>;
	let ctx: MessageHandlerContext;
	const client = {} as WebClient;

	beforeEach(() => {
		vi.clearAllMocks();
		send = vi.fn();
		ctx = { send } as unknown as MessageHandlerContext;
		mockList.mockReturnValue([outage]);
	});

	it('status lists the unreachable remotes and echoes the request id', () => {
		handleSshReachabilityStatus(ctx, client, { type: 'ssh_reachability_status', requestId: 'q1' });
		expect(send).toHaveBeenCalledWith(client, {
			type: 'ssh_reachability_status_result',
			success: true,
			unreachable: [outage],
			requestId: 'q1',
		});
	});

	it('check probes the named remote and returns its state', async () => {
		mockCheck.mockResolvedValue(false);
		await handleSshReachabilityCheck(ctx, client, {
			type: 'ssh_reachability_check',
			remoteId: 'r1',
			requestId: 'q2',
		});
		expect(mockCheck).toHaveBeenCalledWith('r1');
		expect(send).toHaveBeenCalledWith(client, {
			type: 'ssh_reachability_check_result',
			success: true,
			reachable: false,
			event: outage,
			requestId: 'q2',
		});
	});

	it('check refuses a message with no remote id', async () => {
		await handleSshReachabilityCheck(ctx, client, { type: 'ssh_reachability_check' });
		expect(mockCheck).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(
			client,
			expect.objectContaining({ success: false, error: 'remoteId is required' })
		);
	});
});
