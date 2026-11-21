import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { handleCreateSession } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers/types';
import type { WebClientMessage } from '../../../../main/web-server/handlers/messageHandlers/types';
import type { MessageHandlerContext } from '../../../../main/web-server/handlers/messageHandlers/types';
import * as fs from 'fs';
import * as path from 'path';
import { isRemoteMethodAllowed } from '../../../../main/web-server/handlers/bridgeDenyList';
__maestroMicrobenchDescribe('createSessionBackground', () => {
	let createSession: ReturnType<typeof vi.fn>;

	function makeCtx(): MessageHandlerContext {
		return {
			send: vi.fn(),
			sendError: vi.fn(),
			callbacks: { createSession },
		} as unknown as MessageHandlerContext;
	}

	/** Dispatch a create_session message and return the background argument seen. */
	function backgroundArg(message: Partial<WebClientMessage>): unknown {
		handleCreateSession(
			makeCtx(),
			{} as WebClient,
			{
				name: 'Agent',
				toolType: 'codex',
				cwd: '/tmp',
				...message,
			} as WebClientMessage
		);
		expect(createSession).toHaveBeenCalled();
		return createSession.mock.calls[0][5];
	}

	beforeEach(() => {
		createSession = vi.fn().mockResolvedValue({ sessionId: 'new-1' });
	});

	describe('handleCreateSession - background intent (issue #1496)', () => {
		it('passes the background flag to the createSession callback', () => {
			expect(backgroundArg({ background: true })).toBe(true);
		});

		it('reports a foreground create as not background', () => {
			expect(backgroundArg({ background: false })).toBe(false);
		});

		it('treats an absent flag as a foreground create', () => {
			// The historical default: a plain `create-agent` selects the new agent.
			expect(backgroundArg({})).toBe(false);
		});

		it('does not treat a truthy non-boolean as background', () => {
			// The field crosses a process boundary from an untrusted client, so the
			// flag is read through `readBackgroundField` rather than coerced.
			expect(backgroundArg({ background: 'yes' as unknown as boolean })).toBe(false);
		});
	});
});
__maestroMicrobenchDescribe('feedbackBridgeChannels', () => {
	const SRC = path.join(__dirname, '../../../../');
	const PRELOAD_PATH = path.join(SRC, 'main/preload/feedback.ts');
	const HANDLERS_PATH = path.join(SRC, 'main/ipc/handlers/feedback.ts');

	/**
	 * Feedback channels a browser must not reach, each with the reason. Empty
	 * today: every step of the dialog runs on the host and is safe to drive
	 * remotely. A channel added here must still leave the dialog usable.
	 */
	const DESKTOP_ONLY_FEEDBACK_CHANNELS: Record<string, string> = {};

	function feedbackChannelsIn(filePath: string): string[] {
		const source = fs.readFileSync(filePath, 'utf-8');
		return [...new Set([...source.matchAll(/['"`](feedback:[\w:-]+)['"`]/g)].map((m) => m[1]))];
	}

	describe('feedback channels over the web bridge', () => {
		const preloadChannels = feedbackChannelsIn(PRELOAD_PATH);
		const handlerChannels = feedbackChannelsIn(HANDLERS_PATH);
		const allChannels = [...new Set([...preloadChannels, ...handlerChannels])].sort();

		it('finds the channels it is meant to guard', () => {
			// A scan that silently matches nothing would pass every check below.
			expect(preloadChannels).toContain('feedback:list-accounts');
			expect(handlerChannels).toContain('feedback:list-accounts');
			expect(allChannels.length).toBeGreaterThanOrEqual(16);
		});

		it('allows every feedback channel or excludes it with a reason', () => {
			const unaccounted = allChannels.filter(
				(channel) => !isRemoteMethodAllowed(channel) && !DESKTOP_ONLY_FEEDBACK_CHANNELS[channel]
			);
			expect(unaccounted).toEqual([]);
		});

		it('does not both allow and exclude a channel', () => {
			const contradictory = Object.keys(DESKTOP_ONLY_FEEDBACK_CHANNELS).filter((channel) =>
				isRemoteMethodAllowed(channel)
			);
			expect(contradictory).toEqual([]);
		});

		it('allows the account picker and the in-app GitHub login', () => {
			for (const channel of [
				'feedback:list-accounts',
				'feedback:remember-account',
				'feedback:gh-login-command',
			]) {
				expect(isRemoteMethodAllowed(channel)).toBe(true);
			}
		});
	});
});
