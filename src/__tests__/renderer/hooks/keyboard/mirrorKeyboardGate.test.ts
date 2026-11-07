/**
 * Tests for the keyboard gate that runs while a Federation peer's mirrored agent is shown.
 *
 * The local active agent is hidden behind the mirror, not replaced, so the gate is an allowlist:
 * a global shortcut passes, a local one (close tab, kill agent, ...) is swallowed, tab cycling
 * walks the mirror's own tabs, and New Tab and Toggle Tab Star go to the host (FED-SSH-06).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../renderer/services/peerMirror', () => ({
	openMirrorTab: vi.fn(async () => undefined),
	starMirrorTab: vi.fn(async () => undefined),
}));

import { openMirrorTab, starMirrorTab } from '../../../../renderer/services/peerMirror';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';
import {
	gateKeyForMirror,
	MIRROR_SAFE_SHORTCUT_IDS,
	type MirrorGateMatchers,
} from '../../../../renderer/hooks/keyboard/mirrorKeyboardGate';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { buildEventFromKeys } from '../../../../renderer/utils/shortcutRecorder';
import { eventMatchesShortcutKeys } from '../../../../renderer/utils/shortcutMatch';
import { resetStores } from '../../../helpers';

/** The same lookups `useKeyboardShortcutHelpers` makes, over the live settings store. */
const matchers: MirrorGateMatchers = {
	isShortcut: (e, id) =>
		eventMatchesShortcutKeys(e, useSettingsStore.getState().shortcuts[id]?.keys),
	isTabShortcut: (e, id) => {
		const { shortcuts, tabShortcuts } = useSettingsStore.getState();
		return eventMatchesShortcutKeys(e, (tabShortcuts[id] || shortcuts[id])?.keys);
	},
	hasOpenLayers: () => false,
};

function eventFor(id: string, map: 'shortcuts' | 'tabShortcuts' = 'shortcuts'): KeyboardEvent {
	const keys = useSettingsStore.getState()[map][id]?.keys;
	if (!keys?.length) throw new Error(`no binding for ${id}`);
	const event = buildEventFromKeys(keys);
	if (!event) throw new Error(`could not build ${id}`);
	return event;
}

function showMirror(): void {
	const agent: AgentRecord = {
		id: 'a1',
		name: 'Builder',
		toolType: 'claude-code',
		aiTabs: [{ id: 't1', starred: true }, { id: 't2' }],
	};
	const peer = replacePeerAgents(
		{
			...createMirroredPeer({ peerId: 'buildbox', remoteId: 'r1', name: 'buildbox' }),
			connection: 'connected',
		},
		[agent],
		[],
		1
	).peer;
	usePeerMirrorStore.getState().hydrate([peer]);
	usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'a1');
}

describe('gateKeyForMirror', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		vi.mocked(openMirrorTab).mockClear();
		vi.mocked(starMirrorTab).mockClear();
	});

	it('passes every key while no mirror is shown', () => {
		const event = eventFor('closeTab', 'tabShortcuts');
		expect(gateKeyForMirror(event, matchers)).toBe('pass');
		expect(event.defaultPrevented).toBe(false);
	});

	it('passes the global shortcuts on the allowlist', () => {
		showMirror();
		for (const id of ['quickAction', 'settings', 'toggleSidebar', 'cycleNext']) {
			expect(MIRROR_SAFE_SHORTCUT_IDS).toContain(id);
			expect(gateKeyForMirror(eventFor(id), matchers)).toBe('pass');
		}
	});

	it('swallows a shortcut that would act on the hidden local agent', () => {
		showMirror();
		for (const [id, map] of [
			['closeTab', 'tabShortcuts'],
			['killInstance', 'shortcuts'],
			['toggleMode', 'shortcuts'],
		] as const) {
			const event = eventFor(id, map);
			expect(gateKeyForMirror(event, matchers)).toBe('blocked');
			expect(event.defaultPrevented).toBe(true);
		}
	});

	it('blocks plain keys without swallowing them, so the focused field still gets them', () => {
		showMirror();
		const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
		expect(gateKeyForMirror(event, matchers)).toBe('blocked');
		expect(event.defaultPrevented).toBe(false);
	});

	it('lets the Opt+Cmd+digit agent jump through: it lands on a local agent', () => {
		showMirror();
		const event = new KeyboardEvent('keydown', {
			key: '1',
			code: 'Digit1',
			altKey: true,
			metaKey: true,
			cancelable: true,
		});
		expect(gateKeyForMirror(event, matchers)).toBe('pass');
	});

	it('answers tab cycling on the mirror its own tabs', () => {
		showMirror();
		const event = eventFor('nextTab');
		expect(gateKeyForMirror(event, matchers)).toBe('handled');
		expect(event.defaultPrevented).toBe(true);
		expect(usePeerMirrorStore.getState().activeTabIds.buildbox.a1).toBe('t2');
	});

	it('does not cycle the mirror behind an open modal', () => {
		showMirror();
		const event = eventFor('nextTab');
		expect(gateKeyForMirror(event, { ...matchers, hasOpenLayers: () => true })).toBe('handled');
		expect(usePeerMirrorStore.getState().activeTabIds.buildbox?.a1).toBeUndefined();
	});

	it('opens a new tab on the host for New Tab, not on the hidden local agent', () => {
		showMirror();
		const event = eventFor('newTab', 'tabShortcuts');
		expect(gateKeyForMirror(event, matchers)).toBe('handled');
		expect(event.defaultPrevented).toBe(true);
		expect(openMirrorTab).toHaveBeenCalledWith('buildbox', 'a1');
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('toggles the star of the shown mirrored tab on the host', () => {
		showMirror();
		expect(gateKeyForMirror(eventFor('toggleTabStar'), matchers)).toBe('handled');
		expect(starMirrorTab).toHaveBeenCalledWith('buildbox', 'a1', 't1', false);
		usePeerMirrorStore.getState().selectMirrorTab('buildbox', 'a1', 't2');
		gateKeyForMirror(eventFor('toggleTabStar'), matchers);
		expect(starMirrorTab).toHaveBeenLastCalledWith('buildbox', 'a1', 't2', true);
	});

	it('does not open or star a tab behind an open modal', () => {
		showMirror();
		const behind = { ...matchers, hasOpenLayers: () => true };
		expect(gateKeyForMirror(eventFor('newTab', 'tabShortcuts'), behind)).toBe('handled');
		expect(gateKeyForMirror(eventFor('toggleTabStar'), behind)).toBe('handled');
		expect(openMirrorTab).not.toHaveBeenCalled();
		expect(starMirrorTab).not.toHaveBeenCalled();
	});
});
