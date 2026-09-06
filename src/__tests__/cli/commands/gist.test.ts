/**
 * @file gist.test.ts
 * @description Tests for the `gist create` CLI command.
 *
 * Focus is the `--session` option: which conversation actually gets published.
 * A gist is readable by anyone holding the URL, so a caller that names a
 * session and gets a different one published has leaked it.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));

import { gistCreate } from '../../../cli/commands/gist';
import { withMaestroClient } from '../../../cli/services/maestro-client';

describe('gist create command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	/** Capture the message sent to the desktop and reply with a successful gist. */
	function captureMessage(): Record<string, unknown> {
		const captured: Record<string, unknown> = {};
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					Object.assign(captured, msg);
					return Promise.resolve({ success: true, gistUrl: 'https://gist.github.com/abc' });
				}),
			};
			return action(mockClient as never);
		});
		return captured;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('omits agentSessionId when no session is requested', async () => {
		const msg = captureMessage();

		await gistCreate('agent-1', {});

		expect(msg.sessionId).toBe('agent-1');
		expect(msg.agentSessionId).toBeUndefined();
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('sends the requested provider session id', async () => {
		const msg = captureMessage();

		await gistCreate('agent-1', { session: 'provider-session-9' });

		expect(msg.sessionId).toBe('agent-1');
		expect(msg.agentSessionId).toBe('provider-session-9');

		const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
		expect(output.success).toBe(true);
		expect(output.agentSessionId).toBe('provider-session-9');
	});

	// A blank `--session` must not degrade into "publish the open tabs" - that is
	// the exact substitution this option exists to prevent. `process.exit` really
	// does end the process here, so the spy throws rather than returning: a spy
	// that returns lets the function run on and publish the very gist the guard
	// just refused.
	it('rejects a blank --session instead of publishing the open tabs', async () => {
		const msg = captureMessage();
		processExitSpy.mockImplementation((code?: number) => {
			throw new Error(`process.exit(${code})`);
		});

		await expect(gistCreate('agent-1', { session: '   ' })).rejects.toThrow('process.exit(1)');

		expect(msg.sessionId).toBeUndefined();
		const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
		expect(output.success).toBe(false);
		expect(output.code).toBe('INVALID_SESSION');
	});

	it('reports the desktop failure rather than claiming success', async () => {
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi
					.fn()
					.mockResolvedValue({ success: false, error: 'No transcript found for session x' }),
			};
			return action(mockClient as never);
		});

		await gistCreate('agent-1', { session: 'x' });

		const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
		expect(output.success).toBe(false);
		expect(output.code).toBe('GIST_CREATE_FAILED');
		expect(output.error).toContain('No transcript found');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
