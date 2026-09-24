/**
 * Background completions: an agent finishing long after its voice turn ended.
 *
 * The tempting implementation - speak it the moment it lands - is wrong in a way
 * that is obvious the first time it happens to you: you are mid-sentence with one
 * agent and a different one starts talking over both of you. So a completion is
 * QUEUED and delivered at the next natural pause, which is the moment the floor
 * is open and nothing is being said or dispatched.
 *
 * Every announcement names its source, using the same idea as the toast system's
 * `sourceAgent` label: the user has no screen and no tab bar, so "the migration
 * is done" is unusable unless it says which agent finished it. That is one
 * identity concept across both surfaces rather than a second one invented here.
 */

import type { BackgroundAnnouncementSetting } from '../../../shared/acappella/announcements';
import { shouldSpeakBackgroundCompletions } from '../../../shared/acappella/announcements';
import type { VoiceScope } from '../../../shared/acappella/protocol';

export interface BackgroundCompletion {
	agentSessionId: string;
	/** The label spoken and shown. Same concept as a toast's `sourceAgent`. */
	agentName: string;
	tabId?: string;
	/** One line of what it finished, from the synopsis the history manager wrote. */
	summary?: string;
}

export interface BackgroundAnnouncement extends BackgroundCompletion {
	/** The sentence to speak, source named. */
	text: string;
	queuedAt: number;
}

export interface BackgroundAnnouncerOptions {
	/** What the session is bound to. Read per queue: the scope can change. */
	getScope: () => VoiceScope;
	getSetting: () => BackgroundAnnouncementSetting | undefined;
	/** The agent the current voice turn is about. Its own completion is not "background". */
	getForegroundAgentSessionId?: () => string | null;
	/** Longest backlog held. Beyond it the oldest are dropped. */
	queueLimit?: number;
	now?: () => number;
}

/**
 * Nobody wants six announcements at once. Past this the OLDEST go, because a
 * completion the user has been waiting on for ten minutes has already been
 * overtaken by the ones behind it.
 */
const DEFAULT_QUEUE_LIMIT = 5;

export class BackgroundAnnouncer {
	private readonly options: BackgroundAnnouncerOptions;
	private readonly queueLimit: number;
	private readonly now: () => number;
	private pending: BackgroundAnnouncement[] = [];

	constructor(options: BackgroundAnnouncerOptions) {
		this.options = options;
		this.queueLimit = Math.max(1, options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
		this.now = options.now ?? Date.now;
	}

	get queued(): BackgroundAnnouncement[] {
		return [...this.pending];
	}

	/**
	 * An agent finished.
	 *
	 * @returns the queued announcement, or `null` when it was declined: the
	 *          setting is off for this scope, or the agent is the one the current
	 *          turn is already about, in which case its reply is the answer and an
	 *          announcement would say the same thing twice.
	 */
	queue(completion: BackgroundCompletion): BackgroundAnnouncement | null {
		if (!shouldSpeakBackgroundCompletions(this.options.getSetting(), this.options.getScope())) {
			return null;
		}
		if (this.options.getForegroundAgentSessionId?.() === completion.agentSessionId) return null;

		const announcement: BackgroundAnnouncement = {
			...completion,
			text: announcementText(completion),
			queuedAt: this.now(),
		};

		this.pending.push(announcement);
		if (this.pending.length > this.queueLimit) {
			this.pending = this.pending.slice(-this.queueLimit);
		}
		return announcement;
	}

	/**
	 * Take the next announcement, if this is a natural pause.
	 *
	 * `atPause` is the caller's answer to "is the floor quiet right now", which
	 * only the session knows. Passing false is not an error: it is the ordinary
	 * case of a completion landing mid-conversation, and the announcement simply
	 * waits.
	 */
	take(atPause: boolean): BackgroundAnnouncement | null {
		if (!atPause) return null;
		return this.pending.shift() ?? null;
	}

	/** Drop the backlog. Called when the session ends: it belonged to that session. */
	clear(): void {
		this.pending = [];
	}
}

export function createBackgroundAnnouncer(
	options: BackgroundAnnouncerOptions
): BackgroundAnnouncer {
	return new BackgroundAnnouncer(options);
}

/**
 * The spoken sentence, source first.
 *
 * Source first rather than last because the listener has to know who is talking
 * before they can make sense of what was done, and because an announcement is
 * arriving out of nowhere in the middle of a different conversation.
 */
export function announcementText(completion: BackgroundCompletion): string {
	const name = completion.agentName.trim() || 'another agent';
	const summary = completion.summary?.replace(/\s+/g, ' ').trim();
	const article = /\bagent\b/i.test(name) ? name : `the ${name} agent`;
	return summary ? `${article} finished ${lowerFirst(summary)}` : `${article} finished.`;
}

/** "Fixed the auth bug" reads as "finished fixed the auth bug" otherwise. */
function lowerFirst(text: string): string {
	const trimmed = text.replace(/\.$/, '');
	// Only when the second character is lowercase: "API rate limiting" must keep
	// its capital, and a sentence that starts with an acronym is common here.
	if (/^[A-Z][a-z]/.test(trimmed)) return `${trimmed[0].toLowerCase()}${trimmed.slice(1)}.`;
	return `${trimmed}.`;
}
