/**
 * Tests for src/renderer/services/queuedPrompt.ts
 *
 * The queue item a non-composer prompt becomes. Three of its fields are easy to
 * drop and each has a visible cost: `tabName` is what a closed tab's item falls
 * back to, `readOnlyMode` is what lets it bypass the parallel-execution guard,
 * and `turnSettings` is what keeps a queued turn on the model it was queued
 * with. The `@mention` flags must be STAMPED but not fired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const planCrossAgentMentions = vi.fn();
vi.mock('../../../renderer/services/crossAgentMentions', () => ({
	planCrossAgentMentions: (...args: unknown[]) => planCrossAgentMentions(...args),
}));

import {
	buildQueuedMessageItem,
	enqueuePromptForTab,
	matchQueuedSlashCommand,
	resolveQueuedItemEdit,
} from '../../../renderer/services/queuedPrompt';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { registerDispatchDepsProvider } from '../../../renderer/stores/retryStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

function seed(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 'session-1',
		aiTabs: [
			createMockAITab({ id: 'a', name: 'Alpha' }),
			createMockAITab({ id: 'b', name: 'Bravo' }),
		],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a' },
			{ type: 'ai', id: 'b' },
		],
		activeTabId: 'a',
		executionQueue: [],
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

function currentQueue() {
	return useSessionStore.getState().sessions[0].executionQueue;
}

describe('buildQueuedMessageItem', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('builds a message item pinned to the given tab', () => {
		const session = seed();
		const item = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[1],
			text: 'carry on',
		});

		expect(item.type).toBe('message');
		expect(item.tabId).toBe('b');
		expect(item.text).toBe('carry on');
		expect(item.tabName).toBe('Bravo');
		// Present, so a queue that drains after a model switch still runs under
		// what was selected when it was queued.
		expect(item.turnSettings).toBeDefined();
	});

	it('marks an item queued from a read-only tab', () => {
		const session = seed({
			aiTabs: [createMockAITab({ id: 'a', name: 'Alpha', readOnlyMode: true })],
			unifiedTabOrder: [{ type: 'ai', id: 'a' }],
		});
		expect(
			buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: 'look only' }).readOnlyMode
		).toBe(true);
	});

	it('stamps the @mention intent without firing the consult', () => {
		planCrossAgentMentions.mockReturnValue({ targetSessionIds: ['other'], suppressLocal: true });
		const session = seed();

		const item = buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: '@Other look' });

		expect(item.crossAgentMention).toBe(true);
		expect(item.crossAgentOnly).toBe(true);
		// Planning only - dispatching is processQueuedItem's job at drain time.
		expect(planCrossAgentMentions).toHaveBeenCalledWith('@Other look', 'session-1');
	});

	it('leaves the mention flags off a message that mentions nobody', () => {
		const session = seed();
		const item = buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: 'plain' });
		expect(item.crossAgentMention).toBeUndefined();
		expect(item.crossAgentOnly).toBeUndefined();
	});

	it('never reads the text for mentions when the caller opts out of planning', () => {
		// A Design Mode pick holds the page's text and HTML. The drain fires a
		// stamped mention as a real consult, so a page saying `@Other` must not
		// stamp one, even though the planner would resolve it.
		planCrossAgentMentions.mockReturnValue({ targetSessionIds: ['other'], suppressLocal: true });
		const session = seed();

		const item = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[0],
			text: 'Ask @Other to fix this',
			planMentions: false,
		});

		expect(planCrossAgentMentions).not.toHaveBeenCalled();
		expect(item.crossAgentMention).toBeUndefined();
		expect(item.crossAgentOnly).toBeUndefined();
	});

	it('forwards the images on an item that has them, and none on one that has not', () => {
		const session = seed();
		const withImage = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[0],
			text: 'look',
			images: ['data:image/png;base64,AAAA'],
		});
		const without = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[0],
			text: 'look',
			images: [],
		});

		expect(withImage.images).toEqual(['data:image/png;base64,AAAA']);
		expect(without).not.toHaveProperty('images');
	});
});

describe('enqueuePromptForTab', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('appends to the tail of the agent execution queue', () => {
		seed();
		enqueuePromptForTab({ sessionId: 'session-1', tabId: 'a', text: 'first' });
		enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'second' });

		expect(currentQueue().map((item) => item.text)).toEqual(['first', 'second']);
	});

	it('falls back to the active tab when the target tab is gone', () => {
		// Losing the prompt because a tab moved is worse than answering it in the
		// tab next door - the caller has already decided this agent gets asked.
		seed();
		const item = enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'vanished',
			text: 'still ask',
		});

		expect(item!.tabId).toBe('a');
		expect(currentQueue()).toHaveLength(1);
	});

	it('queues the images with the text, and carries the mention opt-out through', () => {
		planCrossAgentMentions.mockReturnValue({ targetSessionIds: ['other'], suppressLocal: false });
		seed();

		const item = enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'b',
			text: 'page says @Other',
			images: ['data:image/png;base64,AAAA'],
			planMentions: false,
		});

		expect(currentQueue()).toEqual([item]);
		expect(item).toMatchObject({
			tabId: 'b',
			text: 'page says @Other',
			images: ['data:image/png;base64,AAAA'],
		});
		expect(item!.crossAgentMention).toBeUndefined();
		expect(planCrossAgentMentions).not.toHaveBeenCalled();
	});

	it('returns null and queues nothing for an unknown agent', () => {
		seed();
		expect(enqueuePromptForTab({ sessionId: 'ghost', tabId: 'a', text: 'nope' })).toBeNull();
		expect(currentQueue()).toHaveLength(0);
	});

	it('returns null when the agent has no AI tab to answer in', () => {
		seed({ aiTabs: [], unifiedTabOrder: [], activeTabId: undefined });
		expect(enqueuePromptForTab({ sessionId: 'session-1', tabId: 'a', text: 'nope' })).toBeNull();
		expect(currentQueue()).toHaveLength(0);
	});
});

describe('matchQueuedSlashCommand', () => {
	beforeEach(() => {
		registerDispatchDepsProvider(() => ({
			conductorProfile: '',
			customAICommands: [
				{ id: 'c1', command: '/commit', description: 'Commit and push', prompt: 'Commit it' },
			],
			speckitCommands: [],
			openspecCommands: [],
		}));
	});

	afterEach(() => {
		registerDispatchDepsProvider(null);
	});

	it('matches one of the user commands, with no arguments', () => {
		const session = seed();
		expect(matchQueuedSlashCommand(session, '  /commit ')).toEqual({
			command: '/commit',
			commandArgs: '',
			description: 'Commit and push',
		});
	});

	it('splits arguments off the command the way the composer does', () => {
		const session = seed();
		expect(matchQueuedSlashCommand(session, '/commit and tag it')).toMatchObject({
			command: '/commit',
			commandArgs: 'and tag it',
		});
	});

	it('matches an agent-discovered command only when it carries a prompt', () => {
		const session = seed({
			agentCommands: [
				{ command: '/review', description: 'Review', prompt: 'Review it' },
				{ command: '/compact', description: 'Compact' },
			],
		});
		expect(matchQueuedSlashCommand(session, '/review')?.command).toBe('/review');
		// A provider's own command stays a message and reaches the provider as typed.
		expect(matchQueuedSlashCommand(session, '/compact')).toBeNull();
	});

	it('is null for ordinary text, unknown commands, and before App wires the deps', () => {
		const session = seed();
		expect(matchQueuedSlashCommand(session, 'please /commit')).toBeNull();
		expect(matchQueuedSlashCommand(session, '/nope')).toBeNull();
		registerDispatchDepsProvider(null);
		expect(matchQueuedSlashCommand(session, '/commit')).toBeNull();
	});
});

describe('resolveQueuedItemEdit', () => {
	const patch = (text: string) => ({ text, images: [], turnSettings: {} });

	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue({ suppressLocal: true });
		registerDispatchDepsProvider(() => ({
			conductorProfile: '',
			customAICommands: [{ id: 'c1', command: '/commit', description: 'Commit', prompt: 'x' }],
			speckitCommands: [],
			openspecCommands: [],
		}));
	});

	afterEach(() => {
		registerDispatchDepsProvider(null);
	});

	it('resolves a slash command and drops the mention flags', () => {
		const session = seed();
		const result = resolveQueuedItemEdit(session, patch('/commit'));

		expect(result.slashCommand?.command).toBe('/commit');
		expect(result.crossAgent).toEqual({ crossAgentMention: false, crossAgentOnly: false });
		expect(planCrossAgentMentions).not.toHaveBeenCalled();
	});

	it('re-derives both mention flags for ordinary text', () => {
		const session = seed();
		const result = resolveQueuedItemEdit(session, patch('@Codex do X'));

		expect(result.slashCommand).toBeUndefined();
		expect(result.crossAgent).toEqual({ crossAgentMention: true, crossAgentOnly: true });
		expect(planCrossAgentMentions).toHaveBeenCalledWith('@Codex do X', 'session-1');
	});
});
