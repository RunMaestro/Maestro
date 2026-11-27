/**
 * @file background-announcer.test.ts
 *
 * An agent finishing long after its voice turn ended. The failure this module
 * exists to prevent is the obvious implementation: a second agent talking over
 * the conversation you are having with the first one.
 */

import { describe, it, expect } from 'vitest';

import {
	BackgroundAnnouncer,
	announcementText,
} from '../../../../main/acappella/speech/background-announcer';
import { shouldSpeakBackgroundCompletions } from '../../../../shared/acappella/announcements';
import type { BackgroundAnnouncementSetting } from '../../../../shared/acappella/announcements';
import type { VoiceScope } from '../../../../shared/acappella/protocol';

function announcer(
	options: {
		scope?: VoiceScope;
		setting?: BackgroundAnnouncementSetting;
		foreground?: string | null;
		queueLimit?: number;
	} = {}
) {
	return new BackgroundAnnouncer({
		getScope: () => options.scope ?? { kind: 'conductor' },
		getSetting: () => options.setting,
		getForegroundAgentSessionId: () => options.foreground ?? null,
		queueLimit: options.queueLimit,
		now: () => 1_000,
	});
}

describe('shouldSpeakBackgroundCompletions', () => {
	it('defaults to on for the Conductor and off inside a focused agent session', () => {
		expect(shouldSpeakBackgroundCompletions(undefined, { kind: 'conductor' })).toBe(true);
		expect(
			shouldSpeakBackgroundCompletions(undefined, { kind: 'agent', sessionId: 'agent-1' })
		).toBe(false);
	});

	it('honours an explicit choice in either scope', () => {
		expect(shouldSpeakBackgroundCompletions('off', { kind: 'conductor' })).toBe(false);
		expect(shouldSpeakBackgroundCompletions('on', { kind: 'agent', sessionId: 'a' })).toBe(true);
	});
});

describe('BackgroundAnnouncer', () => {
	it('holds an announcement until the conversation reaches a pause', () => {
		const queue = announcer();
		queue.queue({ agentSessionId: 'agent-2', agentName: 'Backend', summary: 'the migration' });

		expect(queue.take(false)).toBeNull();
		expect(queue.take(true)?.text).toBe('the Backend agent finished the migration.');
		expect(queue.take(true)).toBeNull();
	});

	it('names the source, because the listener has no tab bar to look at', () => {
		expect(
			announcementText({
				agentSessionId: 'a',
				agentName: 'Backend',
				summary: 'Fixed the auth bug',
			})
		).toBe('the Backend agent finished fixed the auth bug.');

		// A name that already says "agent" is not doubled up.
		expect(announcementText({ agentSessionId: 'a', agentName: 'Docs Agent' })).toBe(
			'Docs Agent finished.'
		);

		// An acronym keeps its capital.
		expect(
			announcementText({ agentSessionId: 'a', agentName: 'API', summary: 'API rate limiting' })
		).toBe('the API agent finished API rate limiting.');
	});

	it('says nothing inside a focused agent session by default', () => {
		const queue = announcer({ scope: { kind: 'agent', sessionId: 'agent-1' } });

		expect(queue.queue({ agentSessionId: 'agent-2', agentName: 'Backend' })).toBeNull();
		expect(queue.take(true)).toBeNull();
	});

	it('does not announce the agent the current turn is already about', () => {
		const queue = announcer({ foreground: 'agent-1' });

		expect(queue.queue({ agentSessionId: 'agent-1', agentName: 'Backend' })).toBeNull();
		expect(queue.queue({ agentSessionId: 'agent-2', agentName: 'Frontend' })).not.toBeNull();
	});

	it('drops the oldest when the backlog outgrows the limit', () => {
		const queue = announcer({ queueLimit: 2 });
		queue.queue({ agentSessionId: 'a1', agentName: 'One' });
		queue.queue({ agentSessionId: 'a2', agentName: 'Two' });
		queue.queue({ agentSessionId: 'a3', agentName: 'Three' });

		expect(queue.queued.map((entry) => entry.agentName)).toEqual(['Two', 'Three']);
	});

	it('drops the backlog with the session it belonged to', () => {
		const queue = announcer();
		queue.queue({ agentSessionId: 'a1', agentName: 'One' });
		queue.clear();

		expect(queue.take(true)).toBeNull();
	});
});
