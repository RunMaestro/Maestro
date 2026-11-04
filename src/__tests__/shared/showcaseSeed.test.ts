/**
 * Guards for the showcase screenshot rig's seed data.
 *
 * `scripts/` sits in the main ESLint config's global `ignores` block and has no
 * tsconfig, so the only automated pass that reaches it is the dash-only lint in
 * `eslint.dashes.config.mjs` - and that one matches `.mjs` / `.js` / `.cjs`,
 * never `.json`. The seed under `scripts/showcase/seed/data/` is therefore
 * unguarded by everything except Prettier, which only checks whitespace.
 *
 * Three failures this catches, the first two of which have already happened:
 *
 * 1. A queued item that is not held. `useQueueProcessing` drains any agent that
 *    is `idle` with a runnable item on the first render after the session load,
 *    which lands well before the shutter, so an unheld seed makes the showcase
 *    app spawn REAL provider processes against the seeded prompts. The count
 *    then drifts between runs and a live spawn error can end up in the
 *    photographed transcript.
 * 2. An em or en dash in seed text. Every string in here is rendered into the
 *    published screenshot set, so it is UI copy by the time anyone sees it.
 * 3. An unread flag the shutter never sees. Unread is the one ephemeral-looking
 *    marker that survives the seed load, so the set depends on it - but it is
 *    cleared by the very act of rendering the tab it sits on.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '../../..');
const SEED_DIR = path.join(REPO_ROOT, 'scripts/showcase/seed/data');
const SESSIONS_SEED = path.join(SEED_DIR, 'maestro-sessions.json');

interface SeedQueueItem {
	id: string;
	timestamp: number;
	tabId: string;
	type: string;
	tabName?: string;
	paused?: boolean;
	text?: string;
	command?: string;
}

interface SeedAiTab {
	id: string;
	name?: string;
	hidden?: boolean;
	hasUnread?: boolean;
}

interface SeedSession {
	id: string;
	name: string;
	activeTabId?: string;
	executionQueue?: SeedQueueItem[];
	aiTabs?: SeedAiTab[];
}

const seedRaw = readFileSync(SESSIONS_SEED, 'utf8');
const seed = JSON.parse(seedRaw) as { sessions: SeedSession[]; activeSessionId?: string };
const sessionsWithQueue = seed.sessions.filter((s) => (s.executionQueue ?? []).length > 0);
const allQueued = seed.sessions.flatMap((s) => s.executionQueue ?? []);

describe('showcase seed: execution queue', () => {
	it('seeds a queue at all', () => {
		// The Execution Queue shot has nothing to photograph without one.
		expect(allQueued.length).toBeGreaterThan(0);
	});

	it('holds every queued item', () => {
		// All-or-nothing: `nextRunnableQueueItem` returns the first item that is
		// not paused, so a single unheld item is enough to start a real spawn.
		const unheld = allQueued.filter((item) => item.paused !== true);
		expect(unheld.map((item) => `${item.id} (${item.tabName ?? item.tabId})`)).toEqual([]);
	});

	it('spreads the queue across more than one agent', () => {
		// The shot exists to show `Current Agent (n)` against `All Agents (m)`
		// with n !== m. One agent owning everything makes both counts the same
		// number and the surface stops demonstrating anything.
		expect(sessionsWithQueue.length).toBeGreaterThan(1);
		const largest = Math.max(...sessionsWithQueue.map((s) => (s.executionQueue ?? []).length));
		expect(largest).toBeLessThan(allQueued.length);
	});

	it('points every item at a real AI tab on its own agent', () => {
		// A dangling tabId falls back to the snapshotted `tabName`, so the card
		// renders under a label no live tab answers to.
		const dangling: string[] = [];
		for (const session of sessionsWithQueue) {
			const tabIds = new Set((session.aiTabs ?? []).map((tab) => tab.id));
			for (const item of session.executionQueue ?? []) {
				if (!tabIds.has(item.tabId)) dangling.push(`${session.name}: ${item.id} -> ${item.tabId}`);
			}
		}
		expect(dangling).toEqual([]);
	});

	it('gives every item the body its type is rendered from', () => {
		const malformed = allQueued.filter((item) =>
			item.type === 'command' ? !item.command : !item.text
		);
		expect(malformed.map((item) => `${item.id} (${item.type})`)).toEqual([]);
	});

	it('uses unique item ids', () => {
		const ids = allQueued.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('showcase seed: unread tabs', () => {
	const unreadTabs = seed.sessions.flatMap((session) =>
		(session.aiTabs ?? []).filter((tab) => tab.hasUnread === true).map((tab) => ({ session, tab }))
	);

	it('seeds unread somewhere', () => {
		// Session restoration resets `state`, `thinkingStartTime` and
		// `isGeneratingName` but never touches `hasUnread`, which is what makes
		// this the one live-looking marker the rig can stage. With none of it the
		// Left Bar dots, the tab-strip bell and the unread filter all photograph
		// as a product nobody is using.
		expect(unreadTabs.length).toBeGreaterThan(0);
	});

	it('never marks a hidden tab unread', () => {
		// A hidden tab draws no chip, so a badge lit by one can never be cleared:
		// the agent opens, every visible tab is already read, and the dot stays.
		// `hasUnreadVisibleTab` filters these out anyway, so the flag is pure
		// noise here - but it is noise that reads as a real state in review.
		const hidden = unreadTabs.filter(({ tab }) => tab.hidden === true);
		expect(hidden.map(({ session, tab }) => `${session.name}: ${tab.name ?? tab.id}`)).toEqual([]);
	});

	it('keeps unread off the tab the shutter is pointed at', () => {
		// The active agent's active tab is rendered before the shutter fires, and
		// rendering it is what clears its unread. Seeding the flag there stages a
		// badge that is gone by the time the image is taken, so the shot silently
		// loses what it was seeded for. Background tabs on the same agent, and
		// the active tab of any OTHER agent, are both safe and both in use here.
		const active = seed.sessions.find((session) => session.id === seed.activeSessionId);
		expect(active).toBeDefined();
		const doomed = (active?.aiTabs ?? []).filter(
			(tab) => tab.hasUnread === true && tab.id === active?.activeTabId
		);
		expect(doomed.map((tab) => tab.name ?? tab.id)).toEqual([]);
	});
});

describe('showcase seed: published copy', () => {
	it('contains no em or en dashes', () => {
		// Both the literal characters and the \u escapes JSON.stringify emits for
		// them, since the seed is rewritten by tooling as well as by hand.
		const offenders = [...seedRaw.matchAll(/—|–|\\u201[34]/g)].map((match) => {
			const start = Math.max(0, match.index - 40);
			return seedRaw.slice(start, match.index + 40).replace(/\n/g, ' ');
		});
		expect(offenders).toEqual([]);
	});
});
