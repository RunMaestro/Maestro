/**
 * Tests for the groupDefaultsPublish service: one save of a group's defaults
 * written to the group's direct members, the toast that is its Undo, and the
 * Undo itself. The rules of what is written are tested without a store in
 * `shared/groupAgentDefaults.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	__resetGroupDefaultsPublishForTests,
	applySeededTokenProxy,
	notifyGroupDefaultsPublished,
	publishGroupDefaults,
	undoGroupDefaultsPublish,
} from '../../../renderer/services/groupDefaultsPublish';
import { dispatchToastClickAction } from '../../../renderer/services/toastClickActions';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Session } from '../../../renderer/types';
import { diffGroupDefaults } from '../../../shared/groupAgentDefaults';
import { createMockSession } from '../../helpers/mockSession';

const GROUP = { id: 'g-backend', name: 'Backend', emoji: '🌳' };
const PROXY_PORT = 48123;
const proxyUrl = (path: string) => `http://127.0.0.1:${PROXY_PORT}${path}`;

const member = (id: string, overrides: Partial<Session> = {}): Session =>
	createMockSession({ id, name: id, groupId: GROUP.id, ...overrides });

function seed(sessions: Session[]): void {
	useSessionStore.setState({ sessions });
}

function stored(id: string): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === id)!;
}

function toasts() {
	return useNotificationStore.getState().toasts;
}

beforeEach(() => {
	__resetGroupDefaultsPublishForTests();
	useNotificationStore.setState({ toasts: [] });
	useSettingsStore.setState({ shellEnvVars: {}, localModelEndpoints: [] });
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	const proxy = window.maestro.localModels.proxy;
	vi.mocked(proxy.ensurePort).mockReset();
	vi.mocked(proxy.ensurePort).mockResolvedValue(PROXY_PORT);
	vi.mocked(proxy.report).mockReset();
	vi.mocked(proxy.report).mockResolvedValue({
		status: { port: PROXY_PORT, running: false, agentIds: [], lastError: null, gatewayUrls: null },
		agents: [],
		usage: null,
		recentCompressions: [],
	} as never);
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockReset();
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockResolvedValue(null);
});

describe('publishGroupDefaults', () => {
	it('writes the change to every direct member before it first yields, and flushes them', async () => {
		seed([member('a'), member('b', { nudgeMessage: 'Mine.' }), member('c')]);
		const diff = diffGroupDefaults({}, { nudgeMessage: 'Be brief.' });

		const pending = publishGroupDefaults(GROUP, diff);
		// Synchronous: the caller's profile write and this are one pass.
		expect(['a', 'b', 'c'].map((id) => stored(id).nudgeMessage)).toEqual([
			'Be brief.',
			'Be brief.',
			'Be brief.',
		]);

		const result = await pending;
		expect(result.agentCount).toBe(3);
		expect(result.agents.map((agent) => agent.id)).toEqual(['a', 'b', 'c']);
		expect(result.publishId).toEqual(expect.any(String));
		expect(result.skipped).toEqual([]);
		// The spawn path reads settings from main's store.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(3);
	});

	it('reaches direct members only: not a child group, not an ungrouped agent', async () => {
		const child = member('child', { groupId: 'g-backend-child' });
		const loose = member('loose', { groupId: undefined });
		seed([member('a'), child, loose]);

		const result = await publishGroupDefaults(GROUP, diffGroupDefaults({}, { nudgeMessage: 'N' }));

		expect(result.agentCount).toBe(1);
		// Not rewritten at all: the same objects are still in the store.
		expect(stored('child')).toBe(child);
		expect(stored('loose')).toBe(loose);
	});

	it('touches no tab and no provider session', async () => {
		const aiTabs = [{ id: 'tab-1', agentSessionId: 'provider-session-1' }] as Session['aiTabs'];
		seed([member('a', { aiTabs, activeTabId: 'tab-1' })]);

		await publishGroupDefaults(GROUP, diffGroupDefaults({}, { nudgeMessage: 'N' }));

		expect(stored('a').aiTabs).toBe(aiTabs);
		expect(stored('a').activeTabId).toBe('tab-1');
	});

	it('keeps no snapshot when no agent changed', async () => {
		const already = member('a', { nudgeMessage: 'N' });
		seed([already]);

		const result = await publishGroupDefaults(GROUP, diffGroupDefaults({}, { nudgeMessage: 'N' }));

		expect(result).toEqual({ publishId: null, agentCount: 0, agents: [], skipped: [] });
		expect(stored('a')).toBe(already);
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('puts an agent on the token proxy through the proxy writer', async () => {
		seed([member('a')]);
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', tokenProxyMode: 'compress' }
		);

		const result = await publishGroupDefaults(GROUP, diff);

		// The mode alone does nothing: the gateway must point at the proxy.
		expect(stored('a').tokenProxyMode).toBe('compress');
		expect(stored('a').gatewayUrl).toBe(proxyUrl('/anthropic'));
		expect(result.agentCount).toBe(1);
	});

	it('reports a setting an agent could not take, and still publishes the rest', async () => {
		seed([
			member('local'),
			member('remote', { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } }),
		]);
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', tokenProxyMode: 'passthrough', nudgeMessage: 'N' }
		);

		const result = await publishGroupDefaults(GROUP, diff);

		expect(stored('remote').nudgeMessage).toBe('N');
		expect(stored('remote').gatewayUrl).toBeUndefined();
		expect(stored('local').gatewayUrl).toBe(proxyUrl('/anthropic'));
		expect(result.skipped).toEqual([
			{
				agentName: 'remote',
				label: 'Maestro Token Proxy',
				reason: expect.stringContaining('SSH remote'),
			},
		]);
	});
});

describe('applySeededTokenProxy', () => {
	it('puts a new agent on the proxy its group names, and flushes it', async () => {
		seed([member('new')]);

		await applySeededTokenProxy('new', { tokenProxyMode: 'compress' });

		// The mode alone does nothing: the gateway must point at the proxy.
		expect(stored('new').tokenProxyMode).toBe('compress');
		expect(stored('new').gatewayUrl).toBe(proxyUrl('/anthropic'));
		expect(window.maestro.sessions.setMany).toHaveBeenCalled();
		expect(toasts()).toEqual([]);
	});

	it('says so when the agent cannot use the proxy, and leaves it off', async () => {
		seed([member('remote', { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } })]);

		await applySeededTokenProxy('remote', { tokenProxyMode: 'passthrough' });

		expect(stored('remote').gatewayUrl).toBeUndefined();
		expect(stored('remote').tokenProxyMode).toBeUndefined();
		expect(toasts()).toHaveLength(1);
		expect(toasts()[0]).toMatchObject({
			color: 'yellow',
			title: 'Some group settings were not applied',
			message: expect.stringContaining('Maestro Token Proxy'),
		});
	});

	it('does nothing with no mode, and nothing for an agent that is not in the store', async () => {
		seed([member('new')]);

		await applySeededTokenProxy('new', {});
		await applySeededTokenProxy('missing', { tokenProxyMode: 'compress' });

		expect(stored('new').gatewayUrl).toBeUndefined();
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
		expect(toasts()).toEqual([]);
	});
});

describe('undoGroupDefaultsPublish', () => {
	it('restores exactly what the publish changed, once', async () => {
		const before = [
			member('a', { nudgeMessage: 'Mine.', customEnvVars: { OWN: 'x' } }),
			member('b'),
		];
		seed(before);
		const diff = diffGroupDefaults(
			{},
			{ nudgeMessage: 'Be brief.', customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' } }
		);
		const { publishId } = await publishGroupDefaults(GROUP, diff);
		expect(stored('a').customEnvVars).toEqual({ OWN: 'x', CLAUDE_CONFIG_DIR: '~/.work' });
		vi.mocked(window.maestro.sessions.setMany).mockClear();

		expect(await undoGroupDefaultsPublish(publishId!)).toBe(true);

		expect(stored('a')).toEqual(before[0]);
		expect(stored('b')).toEqual(before[1]);
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(2);
		expect(toasts().at(-1)?.title).toBe('Publish undone');

		// A snapshot is restored once.
		expect(await undoGroupDefaultsPublish(publishId!)).toBe(false);
		expect(toasts().at(-1)?.title).toBe('Nothing to undo');
	});

	it('takes an agent back off the proxy', async () => {
		seed([member('a')]);
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', tokenProxyMode: 'compress' }
		);
		const { publishId } = await publishGroupDefaults(GROUP, diff);

		await undoGroupDefaultsPublish(publishId!);

		expect(stored('a').gatewayUrl).toBeUndefined();
		expect(stored('a').tokenProxyMode).toBeUndefined();
	});

	it('skips an agent that was deleted since', async () => {
		seed([member('a'), member('b')]);
		const { publishId } = await publishGroupDefaults(
			GROUP,
			diffGroupDefaults({}, { nudgeMessage: 'N' })
		);
		seed([stored('b')]);

		expect(await undoGroupDefaultsPublish(publishId!)).toBe(true);
		expect(stored('b').nudgeMessage).toBeUndefined();
		expect(toasts().at(-1)?.message).toContain('Restored 1 agent in');
	});
});

describe('notifyGroupDefaultsPublished', () => {
	it('fires a toast whose click is the Undo', async () => {
		seed([member('a'), member('b')]);
		const diff = diffGroupDefaults({}, { nudgeMessage: 'Be brief.' });
		const result = await publishGroupDefaults(GROUP, diff);

		notifyGroupDefaultsPublished(GROUP, diff, result);

		const toast = toasts()[0];
		expect(toast.title).toBe('Published to 2 agents');
		expect(toast.message).toBe('Nudge Message in 🌳 Backend. Click to undo.');
		expect(toast.clickAction).toEqual({ kind: 'undo-group-publish', publishId: result.publishId });

		dispatchToastClickAction(toast.clickAction!);
		await vi.waitFor(() => expect(stored('a').nudgeMessage).toBeUndefined());
		expect(stored('b').nudgeMessage).toBeUndefined();
	});

	it('says so when every agent already had the settings', () => {
		notifyGroupDefaultsPublished(GROUP, diffGroupDefaults({}, { nudgeMessage: 'N' }), {
			publishId: null,
			agentCount: 0,
			agents: [],
			skipped: [],
		});

		expect(toasts()).toHaveLength(1);
		expect(toasts()[0].title).toBe('Nothing to publish');
		expect(toasts()[0].clickAction).toBeUndefined();
	});

	it('reports skipped settings in a toast that stays up', () => {
		notifyGroupDefaultsPublished(GROUP, diffGroupDefaults({}, { nudgeMessage: 'N' }), {
			publishId: 'publish-1',
			agentCount: 1,
			agents: [{ id: 'a', name: 'Scraper' }],
			skipped: [{ agentName: 'Scraper', label: 'Run On', reason: 'Cannot reach it.' }],
		});

		expect(toasts().map((toast) => toast.title)).toEqual([
			'Published to 1 agent',
			'Some settings were not published',
		]);
		expect(toasts()[1].message).toBe('Scraper: Run On. Cannot reach it.');
		expect(toasts()[1].dismissible).toBe(true);
	});
});
