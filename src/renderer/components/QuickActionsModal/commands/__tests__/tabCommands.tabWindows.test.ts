/**
 * Tab Windows entries of the command palette (TW-11): "Move Tab to Tab Window"
 * for the shown tab, and one "Dock Tab: <name>" per tab of the agent that is
 * out. Both hide in web-desktop (TW-13), for a hidden consult tab (TW-14), and
 * while a group chat owns the view. Each calls the tabWindowActions service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runtime = vi.hoisted(() => ({ webDesktop: false }));
vi.mock('../../../../utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../utils/runtimeContext')>()),
	isWebDesktop: () => runtime.webDesktop,
	isTabWindow: () => false,
}));

const service = vi.hoisted(() => ({ popOutTabFromUi: vi.fn(), dockTabFromUi: vi.fn() }));
vi.mock('../../../../services/tabWindowActions', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../services/tabWindowActions')>()),
	popOutTabFromUi: service.popOutTabFromUi,
	dockTabFromUi: service.dockTabFromUi,
}));

import { buildTabCommands } from '../tabCommands';
import { useTabWindowStore } from '../../../../stores/tabWindowStore';
import {
	createMockAITab,
	createMockFileTab,
	createMockSession,
	installTabWindowsApi,
} from '../../../../../__tests__/helpers';
import type { Session } from '../../../../types';

const AGENT = 'agent-1';
const SHORTCUT = {
	id: 'moveTabToTabWindow',
	label: 'Move Tab to Tab Window',
	keys: ['Alt', 'Meta', 'o'],
};

function session(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: AGENT,
		aiTabs: [
			createMockAITab({ id: 'a1', name: 'Chat One' }),
			createMockAITab({ id: 'consult', hidden: true }),
		],
		filePreviewTabs: [createMockFileTab({ id: 'f1', name: 'notes.md' })],
		activeTabId: 'a1',
		...overrides,
	});
}

function build(activeSession: Session | undefined, activeGroupChatId: string | null = null) {
	const setQuickActionOpen = vi.fn();
	const commands = buildTabCommands({
		activeSession,
		activeGroupChatId,
		isAiMode: true,
		activeTabInfo: {
			isTerminalMode: false,
			hasActiveTab: true,
			activeUnifiedIndex: 0,
			unifiedTabCount: 1,
			activeTabType: 'ai',
		},
		enterToSendAI: true,
		setQuickActionOpen,
		shortcuts: { moveTabToTabWindow: SHORTCUT },
		toggleInputMode: vi.fn(),
	});
	return { commands, setQuickActionOpen };
}

let api: ReturnType<typeof installTabWindowsApi>;

beforeEach(() => {
	runtime.webDesktop = false;
	service.popOutTabFromUi.mockClear();
	service.dockTabFromUi.mockClear();
	api = installTabWindowsApi();
	useTabWindowStore.getState().setWindows([]);
});

afterEach(() => api.restore());

describe('Move Tab to Tab Window', () => {
	it('pops the shown tab out through the service and closes the palette', () => {
		const { commands, setQuickActionOpen } = build(session());
		const entry = commands.find((c) => c.id === 'moveTabToTabWindow');
		expect(entry?.label).toBe('Move Tab to Tab Window');
		expect(entry?.shortcut).toBe(SHORTCUT);
		entry?.action();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(service.popOutTabFromUi).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a1' });
	});

	it('is hidden in the web-desktop build (TW-13)', () => {
		runtime.webDesktop = true;
		expect(build(session()).commands.some((c) => c.id === 'moveTabToTabWindow')).toBe(false);
	});

	it('is hidden for a hidden consult tab (TW-14)', () => {
		const { commands } = build(session({ activeTabId: 'consult' }));
		expect(commands.some((c) => c.id === 'moveTabToTabWindow')).toBe(false);
	});

	it('is hidden while a group chat owns the view', () => {
		expect(build(session(), 'room-1').commands.some((c) => c.id === 'moveTabToTabWindow')).toBe(
			false
		);
	});
});

describe('Dock Tab', () => {
	const poppedOut = () =>
		useTabWindowStore.getState().setWindows([
			{
				windowId: 'tw-1',
				agentId: AGENT,
				tabRefs: [
					{ type: 'ai', id: 'a1' },
					{ type: 'file', id: 'f1' },
				],
				activeTabRef: { type: 'ai', id: 'a1' },
			},
		]);

	it('names each tab that is out and docks it through the service', () => {
		poppedOut();
		const { commands, setQuickActionOpen } = build(session());
		const docks = commands.filter((c) => c.id.startsWith('dockTab:'));
		expect(docks.map((c) => c.label)).toEqual(['Dock Tab: Chat One', 'Dock Tab: notes.md']);
		docks[1].action();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(service.dockTabFromUi).toHaveBeenCalledWith(AGENT, { type: 'file', id: 'f1' });
	});

	it('offers nothing when the agent has no tab window', () => {
		expect(build(session()).commands.some((c) => c.id.startsWith('dockTab:'))).toBe(false);
	});

	it('is hidden in the web-desktop build (TW-13)', () => {
		poppedOut();
		runtime.webDesktop = true;
		expect(build(session()).commands.some((c) => c.id.startsWith('dockTab:'))).toBe(false);
	});
});
