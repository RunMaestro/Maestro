/**
 * @file routing-context.test.ts
 *
 * The bounding rules, the tab states, and the promise that no second summarizer
 * exists: every topic here comes out of data the app already had.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../main/stores/getters', () => ({ getSessionsStore: vi.fn() }));

import {
	buildRoutingContext,
	buildRoutingRoster,
	deriveTabTopic,
	serializeRoutingContext,
} from '../../../../main/acappella/router/routing-context';
import type { StoredSession } from '../../../../main/stores/types';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
	return createMockSession(overrides as never) as unknown as StoredSession;
}

function sessions(): StoredSession[] {
	return [
		makeSession({
			id: 'agent-backend',
			name: 'Backend',
			toolType: 'claude-code',
			cwd: '/repo/api',
			state: 'idle',
			aiTabs: [
				createMockAITab({
					id: 'tab-auth',
					name: 'Auth Refactor',
					createdAt: 1_000,
					logs: [
						{ id: 'l1', timestamp: 2_000, source: 'user', text: 'rewrite the auth middleware' },
						{ id: 'l2', timestamp: 4_000, source: 'ai', text: 'done' },
					] as never,
				}),
				createMockAITab({ id: 'tab-db', name: 'DB Migrations', createdAt: 9_000 }),
			],
		}),
	];
}

describe('buildRoutingRoster', () => {
	it('lists open tabs with a topic derived from the conversation', () => {
		const [agent] = buildRoutingRoster(sessions());

		expect(agent.tabs[0]).toMatchObject({
			id: 'tab-auth',
			name: 'Auth Refactor',
			state: 'open',
			topic: 'rewrite the auth middleware',
			lastActiveAt: 4_000,
		});
	});

	it('lists snoozed tabs so recall can reach them', () => {
		const list = sessions();
		list[0].snoozedTabs = [
			{
				id: 'snooze-1',
				tab: createMockAITab({ id: 'tab-spike', name: 'Rate Limit Spike', createdAt: 500 }),
				unifiedIndex: 0,
				snoozedAt: 100,
				wakeAt: 999_999,
			},
		];

		const [agent] = buildRoutingRoster(list);

		expect(agent.tabs.find((tab) => tab.id === 'tab-spike')).toMatchObject({ state: 'snoozed' });
	});

	it('lists closed AI tabs and ignores closed file and terminal tabs', () => {
		const list = sessions();
		list[0].unifiedClosedTabHistory = [
			{ type: 'ai', tab: createMockAITab({ id: 'tab-old', name: 'Old Spike' }), index: 0 },
			{ type: 'terminal', tab: { id: 'term-1' }, index: 1 },
		];

		const [agent] = buildRoutingRoster(list);

		expect(agent.tabs.find((tab) => tab.id === 'tab-old')).toMatchObject({ state: 'closed' });
		expect(agent.tabs.some((tab) => tab.id === 'term-1')).toBe(false);
	});

	it('omits hidden consult tabs', () => {
		const list = sessions();
		list[0].aiTabs.push(createMockAITab({ id: 'tab-consult', name: 'Consult', hidden: true }));

		const [agent] = buildRoutingRoster(list);

		expect(agent.tabs.some((tab) => tab.id === 'tab-consult')).toBe(false);
	});

	it('keeps the open copy when a tab appears open and closed at once', () => {
		const list = sessions();
		list[0].unifiedClosedTabHistory = [
			{ type: 'ai', tab: createMockAITab({ id: 'tab-auth', name: 'Auth Refactor' }), index: 0 },
		];

		const [agent] = buildRoutingRoster(list);

		expect(agent.tabs.filter((tab) => tab.id === 'tab-auth')).toHaveLength(1);
		expect(agent.tabs.find((tab) => tab.id === 'tab-auth')?.state).toBe('open');
	});

	it('survives a session with no tabs at all', () => {
		expect(buildRoutingRoster([makeSession({ id: 'a1', aiTabs: undefined })])[0].tabs).toEqual([]);
	});
});

describe('deriveTabTopic', () => {
	it('prefers the opening message, which the name already compresses', () => {
		const tab = {
			logs: [{ source: 'user', text: 'why is the migration locking the users table' }],
		};

		expect(deriveTabTopic(tab, 'DB Migrations')).toBe(
			'why is the migration locking the users table'
		);
	});

	it('falls back to the name when the transcript has no user message', () => {
		expect(deriveTabTopic({ logs: [] }, 'DB Migrations')).toBe('DB Migrations');
	});

	it('is null when there is nothing to say', () => {
		expect(deriveTabTopic({ logs: [] }, null)).toBeNull();
	});

	it('truncates and collapses so a pasted stack trace is still one line', () => {
		const topic = deriveTabTopic({ logs: [{ source: 'user', text: 'x\n\ty '.repeat(200) }] }, null);

		expect(topic).toMatch(/…$/);
		expect(topic!.length).toBeLessThanOrEqual(90);
		expect(topic).not.toContain('\n');
	});
});

describe('buildRoutingContext', () => {
	it('carries the agent status and the history synopsis', () => {
		const context = buildRoutingContext({
			sessions: sessions(),
			synopses: new Map([['agent-backend', 'Landed the auth refactor']]),
		});

		expect(context.agents[0].status).toBe('idle');
		expect(context.agents[0].recentWork).toBe('Landed the auth refactor');
		expect(serializeRoutingContext(context)).toContain('recently: Landed the auth refactor');
	});

	it('reports its own serialized size', () => {
		const context = buildRoutingContext({ sessions: sessions() });

		expect(context.serializedChars).toBe(serializeRoutingContext(context).length);
	});

	it('drops the least recently used tabs to stay under the cap, and says how many', () => {
		const many = makeSession({
			id: 'agent-busy',
			name: 'Busy',
			aiTabs: Array.from({ length: 40 }, (_, index) =>
				createMockAITab({
					id: `tab-${index}`,
					name: `Conversation number ${index}`,
					createdAt: index,
				})
			),
		});

		const context = buildRoutingContext({ sessions: [many], maxChars: 400 });

		expect(context.droppedTabs).toBeGreaterThan(0);
		expect(context.serializedChars).toBeLessThanOrEqual(400);
		// What survives is what the user was most recently doing.
		expect(context.agents[0].tabs.map((tab) => tab.id)).toContain('tab-39');
		expect(context.agents[0].tabs.map((tab) => tab.id)).not.toContain('tab-0');
	});

	it('never drops an agent, even under an impossible cap', () => {
		const context = buildRoutingContext({ sessions: sessions(), maxChars: 1 });

		// An agent missing from the roster cannot be routed to at all; a missing
		// tab only costs a recall the user can repeat with more words.
		expect(context.agents).toHaveLength(1);
		expect(context.agents[0].tabs.length).toBeGreaterThan(0);
	});

	it('serializes an empty roster without pretending anything is running', () => {
		const context = buildRoutingContext({ sessions: [] });

		expect(serializeRoutingContext(context)).toContain('(none)');
	});

	it('includes the voice conversation, not the agent transcripts', () => {
		const context = buildRoutingContext({
			sessions: sessions(),
			recentUtterances: ['run the tests', 'what broke'],
		});

		const text = serializeRoutingContext(context);
		expect(text).toContain('Earlier in this conversation:');
		expect(text).toContain('what broke');
	});
});
