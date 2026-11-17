/**
 * Main's half of the remote command receipt: a renderer claims a command
 * before running it, then reports the outcome. The contract is in
 * `src/shared/remoteCommandReceipt.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ipc = vi.hoisted(() => {
	const listeners = new Map<string, (event: unknown, raw: unknown) => void>();
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	return {
		listeners,
		handlers,
		ipcMain: {
			on: vi.fn((channel: string, listener: (event: unknown, raw: unknown) => void) => {
				listeners.set(channel, listener);
			}),
			removeListener: vi.fn((channel: string) => {
				listeners.delete(channel);
			}),
			handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
				if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
				handlers.set(channel, handler);
			}),
		},
	};
});

vi.mock('electron', () => ({ ipcMain: ipc.ipcMain }));

import { requestRemoteCommandReceipt } from '../../../../main/web-server/callbacks/remoteCommandReceipt';
import {
	REMOTE_COMMAND_CLAIM_CHANNEL,
	REMOTE_COMMAND_CLAIM_TIMEOUT_MS,
} from '../../../../shared/remoteCommandReceipt';

const OUTCOME_TIMEOUT_MS = 4000;

function makeWindow() {
	const webContents = { send: vi.fn() };
	return { win: { webContents } as never, webContents };
}

/** The receipt channel main appended to the most recent send. */
function receiptChannelOf(webContents: { send: ReturnType<typeof vi.fn> }): string {
	const call = webContents.send.mock.calls.at(-1)!;
	return call[call.length - 1] as string;
}

/** The renderer asks main whether the command is still wanted. */
function claim(sender: unknown, receiptChannel: unknown): unknown {
	return ipc.handlers.get(REMOTE_COMMAND_CLAIM_CHANNEL)!({ sender }, receiptChannel);
}

/** The renderer reports what happened to the command. */
function reportOutcome(sender: unknown, receiptChannel: string, raw: unknown): void {
	ipc.listeners.get(receiptChannel)?.({ sender }, raw);
}

describe('requestRemoteCommandReceipt', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends the command with the receipt channel as its last argument', () => {
		const { win, webContents } = makeWindow();

		void requestRemoteCommandReceipt(win, ['agent-1', 'do it', 'ai'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});

		expect(webContents.send).toHaveBeenCalledWith(
			'remote:executeCommand',
			'agent-1',
			'do it',
			'ai',
			expect.stringContaining('remote:executeCommand:response:')
		);
	});

	it('resolves with the outcome the renderer reports after claiming', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});
		const channel = receiptChannelOf(webContents);

		expect(claim(webContents, channel)).toBe(true);
		reportOutcome(webContents, channel, { accepted: false, reason: 'tab-busy' });

		await expect(pending).resolves.toEqual({ accepted: false, reason: 'tab-busy' });
	});

	// The bug this replaced: a turn that is slow to start (a long `git status`
	// while the system prompt is built) outlasted a 3s reply window, and a
	// prompt that went on to run was reported as not delivered.
	it('waits past the claim window for the outcome of a claimed command', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: 60_000,
		});
		const channel = receiptChannelOf(webContents);

		claim(webContents, channel);
		await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_CLAIM_TIMEOUT_MS * 5);
		reportOutcome(webContents, channel, { accepted: true });

		await expect(pending).resolves.toEqual({ accepted: true, reason: undefined });
	});

	it('reports a claimed command whose outcome is slow as accepted and pending', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});

		claim(webContents, receiptChannelOf(webContents));
		await vi.advanceTimersByTimeAsync(OUTCOME_TIMEOUT_MS);

		await expect(pending).resolves.toEqual({ accepted: true, pending: true });
	});

	it('reports a command no renderer claimed as not delivered', async () => {
		const { win } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});

		await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_CLAIM_TIMEOUT_MS);

		await expect(pending).resolves.toEqual({
			accepted: false,
			reason: 'renderer-timeout',
			timedOut: true,
		});
	});

	// What makes "not delivered" true: a renderer that was frozen past the
	// claim window is told to drop the command when it finally picks it up.
	it('refuses a claim that arrives after the claim window closed', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});
		const channel = receiptChannelOf(webContents);

		await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_CLAIM_TIMEOUT_MS);
		await pending;

		expect(claim(webContents, channel)).toBe(false);
	});

	it('lets a command be claimed once', () => {
		const { win, webContents } = makeWindow();
		void requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});
		const channel = receiptChannelOf(webContents);

		expect(claim(webContents, channel)).toBe(true);
		expect(claim(webContents, channel)).toBe(false);
	});

	it('refuses a claim from a renderer the command was not sent to', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});
		const channel = receiptChannelOf(webContents);

		expect(claim({ send: vi.fn() }, channel)).toBe(false);
		expect(claim(webContents, 'remote:executeCommand:response:unknown')).toBe(false);
		expect(claim(webContents, undefined)).toBe(false);

		// Still unclaimed, so the claim window still closes it.
		await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_CLAIM_TIMEOUT_MS);
		await expect(pending).resolves.toMatchObject({ accepted: false, timedOut: true });
	});

	it('ignores an outcome from another renderer', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});
		const channel = receiptChannelOf(webContents);

		claim(webContents, channel);
		reportOutcome({ send: vi.fn() }, channel, { accepted: false, reason: 'forged' });
		reportOutcome(webContents, channel, { accepted: true });

		await expect(pending).resolves.toMatchObject({ accepted: true });
	});

	it('reads a malformed outcome as a failure', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});
		const channel = receiptChannelOf(webContents);

		claim(webContents, channel);
		reportOutcome(webContents, channel, { accepted: 'yes' });

		await expect(pending).resolves.toEqual({ accepted: false, reason: 'malformed-receipt' });
	});

	it('reports a send that throws as not delivered and stops listening', async () => {
		const { win, webContents } = makeWindow();
		webContents.send.mockImplementation(() => {
			throw new Error('Object has been destroyed');
		});

		const receipt = await requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});

		expect(receipt).toMatchObject({ accepted: false, timedOut: true });
		const channel = receiptChannelOf(webContents);
		expect(ipc.listeners.has(channel)).toBe(false);
		// Its claim window is closed too.
		expect(claim(webContents, channel)).toBe(false);
	});

	it('stops listening once the receipt is settled', async () => {
		const { win, webContents } = makeWindow();
		const pending = requestRemoteCommandReceipt(win, ['agent-1', 'do it'], {
			outcomeTimeoutMs: OUTCOME_TIMEOUT_MS,
		});
		const channel = receiptChannelOf(webContents);

		claim(webContents, channel);
		reportOutcome(webContents, channel, { accepted: true });
		await pending;

		expect(ipc.listeners.has(channel)).toBe(false);
	});

	it('registers the claim handler once across requests', () => {
		const { win } = makeWindow();
		void requestRemoteCommandReceipt(win, ['a'], { outcomeTimeoutMs: OUTCOME_TIMEOUT_MS });
		void requestRemoteCommandReceipt(win, ['b'], { outcomeTimeoutMs: OUTCOME_TIMEOUT_MS });

		expect(ipc.handlers.size).toBe(1);
	});
});
