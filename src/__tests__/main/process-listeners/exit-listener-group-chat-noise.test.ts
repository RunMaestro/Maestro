/**
 * Group-chat routing noise filter on the process exit listener.
 *
 * Participants keep running after the user deletes their group chat, so the
 * exit that fires later routes into a chat `loadGroupChat` can no longer find
 * and `routeAgentResponse` throws `Group chat not found: <id>`. The listener
 * already recovers (participant marked done, buffer cleared), and it retries
 * once through the fallback path, so a single deleted chat produced two Sentry
 * events per participant (MAESTRO-M4).
 *
 * The predicate must stay narrow: any other routing failure is still a defect
 * worth reporting.
 */

import { describe, it, expect } from 'vitest';
import { isDeletedGroupChatFailure } from '../../../main/process-listeners/exit-listener';

describe('isDeletedGroupChatFailure', () => {
	it('matches the error routeAgentResponse throws for a deleted chat', () => {
		expect(
			isDeletedGroupChatFailure(
				new Error('Group chat not found: f8186909-d9d1-41e3-9241-a88c99e38f6e')
			)
		).toBe(true);
	});

	it('matches regardless of case', () => {
		expect(isDeletedGroupChatFailure(new Error('GROUP CHAT NOT FOUND: abc-123'))).toBe(true);
	});

	it('matches a non-Error thrown value carrying the same message', () => {
		expect(isDeletedGroupChatFailure('Group chat not found: abc-123')).toBe(true);
	});

	it('does not match a missing participant - the chat still exists', () => {
		expect(
			isDeletedGroupChatFailure(new Error("Participant 'alice' not found in group chat"))
		).toBe(false);
	});

	it('does not match the post-update variant, which means a broken write', () => {
		expect(
			isDeletedGroupChatFailure(new Error('Group chat not found after participant update: abc-123'))
		).toBe(false);
	});

	it('does not match unrelated routing failures', () => {
		expect(isDeletedGroupChatFailure(new Error('ENOENT: no such file or directory'))).toBe(false);
		expect(isDeletedGroupChatFailure(new Error('Unexpected token < in JSON'))).toBe(false);
		expect(isDeletedGroupChatFailure(undefined)).toBe(false);
		expect(isDeletedGroupChatFailure(null)).toBe(false);
	});
});
