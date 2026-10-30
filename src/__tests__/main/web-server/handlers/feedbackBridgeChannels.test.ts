/**
 * Send Feedback over the web interface.
 *
 * The bridge allowlist (`bridgeDenyList.ts`) is an exact inventory, so a new
 * `feedback:*` channel is NOT reachable from a browser until someone lists it.
 * Forgetting `feedback:list-accounts` made the dialog fail on open for every
 * remote user ("Could not detect AI providers"), which also took away their
 * way to report it. This test reads every channel the preload invokes and every
 * channel the main process registers, and requires each one to be either on
 * the allowlist or excluded below with a reason.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isRemoteMethodAllowed } from '../../../../main/web-server/handlers/bridgeDenyList';

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
