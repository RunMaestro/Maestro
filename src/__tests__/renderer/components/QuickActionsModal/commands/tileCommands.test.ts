import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Session } from '../../../../../renderer/types';
import { buildTileCommands } from '../../../../../renderer/components/QuickActionsModal/commands/tileCommands';
import { filterAndSortQuickActions } from '../../../../../renderer/components/QuickActionsModal/utils/quickActionSorting';

const isWebDesktop = vi.fn(() => false);
const updateSessionWith = vi.fn();
const requestPaneFocus = vi.fn();
const notifyCenterFlash = vi.fn();

vi.mock('../../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => isWebDesktop(),
}));
vi.mock('../../../../../renderer/stores/sessionStore', () => ({
	updateSessionWith: (id: string, updater: (s: Session) => Session) =>
		updateSessionWith(id, updater),
}));
vi.mock('../../../../../renderer/stores/uiStore', () => ({
	useUIStore: { getState: () => ({ requestPaneFocus }) },
}));
vi.mock('../../../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: (args: unknown) => notifyCenterFlash(args),
}));
vi.mock('../../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: {
		getState: () => ({
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
			browserHomeUrl: 'https://example.com',
		}),
	},
}));

function session(extra?: Partial<Session>): Session {
	return {
		id: 'sess-1',
		aiTabs: [{ id: 'ai-1', name: 'Chat', logs: [] }],
		activeTabId: 'ai-1',
		filePreviewTabs: [],
		terminalTabs: [],
		browserTabs: [],
		activeFileTabId: null,
		activeBrowserTabId: null,
		activeTerminalTabId: null,
		inputMode: 'ai',
		tabGroups: [],
		activeGroupId: null,
		unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
		...extra,
	} as unknown as Session;
}

function build(
	activeSession: Session | undefined,
	shortcuts?: Parameters<typeof buildTileCommands>[0]['shortcuts']
) {
	const setQuickActionOpen = vi.fn();
	return {
		actions: buildTileCommands({ activeSession, setQuickActionOpen, shortcuts }),
		setQuickActionOpen,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	isWebDesktop.mockReturnValue(false);
});

describe('buildTileCommands', () => {
	it('offers one command per tab kind', () => {
		expect(build(session()).actions.map((a) => a.id)).toEqual([
			'tileBelow:ai',
			'tileBelow:browser',
			'tileBelow:file',
			'tileBelow:terminal',
		]);
	});

	it('offers nothing without a session or with no tab on screen', () => {
		expect(build(undefined).actions).toEqual([]);
		expect(build(session({ aiTabs: [], unifiedTabOrder: [] })).actions).toEqual([]);
	});

	it('hides the browser tile in the web-desktop bundle, where <webview> is inert', () => {
		isWebDesktop.mockReturnValue(true);
		expect(build(session()).actions.map((a) => a.id)).not.toContain('tileBelow:browser');
	});

	it('is findable as a family by typing "tile"', () => {
		// The palette filters on a plain label substring, so the shared "Tile"
		// prefix is the only thing clustering these four. Pin it against a rename.
		const { actions } = build(session());
		const matched = filterAndSortQuickActions(actions, 'tile', 'main');
		expect(matched).toHaveLength(4);
		expect(matched.every((a) => a.label.startsWith('Tile'))).toBe(true);
	});

	it('badges a row only once its shortcut is actually bound', () => {
		// The family ships on Ctrl+Cmd now, but an install migrating up from the
		// unbound era can still hand this an empty `keys`. Rendering an empty pill
		// next to the label reads as a broken badge, so such a row must carry no
		// shortcut at all rather than a blank one.
		const { actions } = build(session(), {
			tileTerminalBelow: { id: 'tileTerminalBelow', label: 'T', keys: ['Control', 'Meta', 'j'] },
			tileAiBelow: { id: 'tileAiBelow', label: 'A', keys: [] },
		});
		const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
		expect(byId['tileBelow:terminal'].shortcut?.keys).toEqual(['Control', 'Meta', 'j']);
		expect(byId['tileBelow:ai'].shortcut).toBeUndefined();
		// Absent from the map entirely is the same story as an empty binding.
		expect(byId['tileBelow:file'].shortcut).toBeUndefined();
	});

	it('shows a user-assigned binding on a previously unbound row', () => {
		const { actions } = build(session(), {
			tileFileBelow: { id: 'tileFileBelow', label: 'F', keys: ['Meta', 'Shift', 'y'] },
		});
		const file = actions.find((a) => a.id === 'tileBelow:file');
		expect(file?.shortcut?.keys).toEqual(['Meta', 'Shift', 'y']);
	});

	it('closes the palette and commits one session update', () => {
		const { actions, setQuickActionOpen } = build(session());
		updateSessionWith.mockImplementation(() => undefined);
		actions[0].action();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(updateSessionWith).toHaveBeenCalledTimes(1);
		expect(updateSessionWith.mock.calls[0][0]).toBe('sess-1');
	});

	it('focuses the freshly tiled pane', () => {
		const { actions } = build(session());
		updateSessionWith.mockImplementation(
			(_id: string, updater: (s: Session) => Session) => void updater(session())
		);
		actions.find((a) => a.id === 'tileBelow:terminal')!.action();
		expect(requestPaneFocus).toHaveBeenCalledTimes(1);
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('flashes instead of silently doing nothing when the tile cannot be built', () => {
		const { actions } = build(session());
		// The session went tab-less between opening the palette and picking the entry.
		updateSessionWith.mockImplementation(
			(_id: string, updater: (s: Session) => Session) =>
				void updater(session({ aiTabs: [], unifiedTabOrder: [] }))
		);
		actions[0].action();
		expect(requestPaneFocus).not.toHaveBeenCalled();
		expect(notifyCenterFlash).toHaveBeenCalledWith(expect.objectContaining({ color: 'yellow' }));
	});
});
