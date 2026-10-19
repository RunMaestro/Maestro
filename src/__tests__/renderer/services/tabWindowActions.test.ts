/**
 * Tests for services/tabWindowActions - the one renderer path every pop-out and
 * dock entry point calls (Tab Windows, TW-11, TW-12): the web-desktop and tab
 * window refusals (TW-13, D1), the hidden consult tab refusal (TW-14), the
 * group detach before a pop-out (D6), and main's answers passed through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runtime = vi.hoisted(() => ({ webDesktop: false, tabWindow: false }));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => runtime.webDesktop,
	isTabWindow: () => runtime.tabWindow,
}));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../renderer/utils/sentry', () => ({ captureException }));

const { notifyToast } = vi.hoisted(() => ({ notifyToast: vi.fn() }));
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast,
}));

import {
	canUseTabWindows,
	dockTab,
	dockTabFromUi,
	popOutRefusal,
	popOutTab,
	popOutTabFromUi,
	resolvePopOutTarget,
	runRemoteTabWindowCommand,
} from '../../../renderer/services/tabWindowActions';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockAITab, createMockSession, installTabWindowsApi } from '../../helpers';
import type { PanelLayoutNode, Session, TabGroup } from '../../../renderer/types';

const AGENT = 'agent-1';

function leaf(id: string, tabId: string): PanelLayoutNode {
	return { kind: 'leaf', id, tab: { type: 'ai', id: tabId } };
}

function group(id: string, tabIds: string[]): TabGroup {
	return {
		id,
		name: 'Group',
		layout: {
			kind: 'split',
			id: `${id}-split`,
			direction: 'row',
			children: tabIds.map((tabId) => leaf(`leaf-${tabId}`, tabId)),
			sizes: tabIds.map(() => 1 / tabIds.length),
		},
		focusedPaneId: `leaf-${tabIds[0]}`,
		createdAt: 0,
	};
}

function seed(overrides: Partial<Session> = {}): void {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: AGENT,
				aiTabs: [
					createMockAITab({ id: 'a1' }),
					createMockAITab({ id: 'a2' }),
					createMockAITab({ id: 'a3' }),
					createMockAITab({ id: 'consult', hidden: true }),
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a1' },
					{ type: 'ai', id: 'a2' },
					{ type: 'ai', id: 'a3' },
				],
				tabGroups: [],
				...overrides,
			}),
		],
	});
}

function agent(): Session {
	return useSessionStore.getState().sessions[0];
}

let api: ReturnType<typeof installTabWindowsApi>;

beforeEach(() => {
	runtime.webDesktop = false;
	runtime.tabWindow = false;
	captureException.mockClear();
	notifyToast.mockClear();
	api = installTabWindowsApi();
	seed();
});

afterEach(() => api.restore());

describe('canUseTabWindows', () => {
	it('is true in an app window of the desktop build', () => {
		expect(canUseTabWindows()).toBe(true);
	});

	it('is false in the web-desktop build (TW-13)', () => {
		runtime.webDesktop = true;
		expect(canUseTabWindows()).toBe(false);
	});

	it('is false inside a tab window (D1)', () => {
		runtime.tabWindow = true;
		expect(canUseTabWindows()).toBe(false);
	});

	it('is false with no tab windows API', () => {
		api.restore();
		const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
		const previous = maestro.tabWindows;
		delete maestro.tabWindows;
		expect(canUseTabWindows()).toBe(false);
		maestro.tabWindows = previous;
	});
});

describe('popOutRefusal', () => {
	it('allows a visible tab of any kind the agent holds', () => {
		expect(popOutRefusal(agent(), { type: 'ai', id: 'a1' })).toBeNull();
	});

	it('refuses a hidden consult tab (TW-14)', () => {
		expect(popOutRefusal(agent(), { type: 'ai', id: 'consult' })).toMatch(/hidden consult/);
	});

	it('refuses a tab the agent does not hold', () => {
		expect(popOutRefusal(agent(), { type: 'file', id: 'nope' })).toMatch(/no such tab/);
	});
});

describe('popOutTab', () => {
	it('calls the pop-out IPC and passes the answer from main through', async () => {
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(api.popOut).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' }, { background: false });
		expect(result).toEqual({ poppedOut: true, windowId: 'tw-1', created: true });
	});

	it('forwards background', async () => {
		await popOutTab(AGENT, { type: 'ai', id: 'a2' }, { background: true });
		expect(api.popOut).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' }, { background: true });
	});

	it('passes a refusal from main through', async () => {
		api.popOut.mockResolvedValue({ poppedOut: false, error: 'nope' });
		expect(await popOutTab(AGENT, { type: 'ai', id: 'a2' })).toEqual({
			poppedOut: false,
			error: 'nope',
		});
	});

	it('does nothing in the web-desktop build (TW-13)', async () => {
		runtime.webDesktop = true;
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result.poppedOut).toBe(false);
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('does nothing inside a tab window (D1)', async () => {
		runtime.tabWindow = true;
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result.poppedOut).toBe(false);
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('refuses a hidden consult tab without asking main (TW-14)', async () => {
		const result = await popOutTab(AGENT, { type: 'ai', id: 'consult' });
		expect(result).toEqual({
			poppedOut: false,
			error: 'A hidden consult tab cannot be popped out',
		});
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('refuses an unknown agent or tab', async () => {
		expect((await popOutTab('ghost', { type: 'ai', id: 'a1' })).poppedOut).toBe(false);
		expect((await popOutTab(AGENT, { type: 'browser', id: 'b9' })).poppedOut).toBe(false);
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('leaves the strip of a standalone tab untouched', async () => {
		const before = agent();
		await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(agent()).toBe(before);
	});

	it('detaches a tiled tab first, right after its group, and dissolves a two-pane group (D6)', async () => {
		seed({
			unifiedTabOrder: [
				{ type: 'group', id: 'g1' },
				{ type: 'ai', id: 'a3' },
			],
			tabGroups: [group('g1', ['a1', 'a2'])],
			activeGroupId: 'g1',
		});
		let orderAtCall: Session['unifiedTabOrder'] | undefined;
		api.popOut.mockImplementation(async () => {
			orderAtCall = agent().unifiedTabOrder;
			return { poppedOut: true, windowId: 'tw-1', created: true };
		});

		await popOutTab(AGENT, { type: 'ai', id: 'a1' });

		// The detach is written before main is asked.
		expect(orderAtCall).toEqual(agent().unifiedTabOrder);
		expect(agent().tabGroups).toEqual([]);
		expect(agent().unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'a2' },
			{ type: 'ai', id: 'a1' },
			{ type: 'ai', id: 'a3' },
		]);
	});

	it('keeps a group that still has two panes', async () => {
		seed({
			unifiedTabOrder: [{ type: 'group', id: 'g1' }],
			tabGroups: [group('g1', ['a1', 'a2', 'a3'])],
		});

		await popOutTab(AGENT, { type: 'ai', id: 'a2' });

		expect(agent().unifiedTabOrder).toEqual([
			{ type: 'group', id: 'g1' },
			{ type: 'ai', id: 'a2' },
		]);
		expect(agent().tabGroups).toHaveLength(1);
		expect(JSON.stringify(agent().tabGroups[0].layout)).not.toContain('"a2"');
	});

	it('reports a rejected IPC call and answers with its message', async () => {
		api.popOut.mockRejectedValue(
			new Error("Error invoking remote method 'tabWindows:popOut': Error: boom")
		);
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result).toEqual({ poppedOut: false, error: 'boom' });
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});

describe('dockTab', () => {
	it('calls the dock IPC and passes the answer from main through', async () => {
		const result = await dockTab(AGENT, { type: 'ai', id: 'a2' });
		expect(api.dock).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' });
		expect(result).toEqual({ docked: true, windowId: 'tw-1' });
	});

	it('runs inside a tab window too (its Dock button)', async () => {
		runtime.tabWindow = true;
		expect((await dockTab(AGENT, { type: 'ai', id: 'a2' })).docked).toBe(true);
	});

	it('does nothing in the web-desktop build (TW-13)', async () => {
		runtime.webDesktop = true;
		const result = await dockTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result.docked).toBe(false);
		expect(api.dock).not.toHaveBeenCalled();
	});

	it('reports a rejected IPC call and answers with its message', async () => {
		api.dock.mockRejectedValue(new Error('gone'));
		expect(await dockTab(AGENT, { type: 'ai', id: 'a2' })).toEqual({
			docked: false,
			error: 'gone',
		});
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});

describe('resolvePopOutTarget', () => {
	it('is the shown standalone tab', () => {
		seed({ activeTabId: 'a2' });
		expect(resolvePopOutTarget(agent())).toEqual({ type: 'ai', id: 'a2' });
	});

	it('is the focused pane of a shown tiled group (D6)', () => {
		seed({
			activeTabId: 'a1',
			tabGroups: [{ ...group('g1', ['a2', 'a3']), focusedPaneId: 'leaf-a3' }],
			activeGroupId: 'g1',
		});
		expect(resolvePopOutTarget(agent())).toEqual({ type: 'ai', id: 'a3' });
	});

	it('is null for a hidden consult tab (TW-14)', () => {
		seed({ activeTabId: 'consult' });
		expect(resolvePopOutTarget(agent())).toBeNull();
	});

	it('is null in the web-desktop build and inside a tab window (TW-13, D1)', () => {
		seed({ activeTabId: 'a2' });
		runtime.webDesktop = true;
		expect(resolvePopOutTarget(agent())).toBeNull();
		runtime.webDesktop = false;
		runtime.tabWindow = true;
		expect(resolvePopOutTarget(agent())).toBeNull();
	});
});

describe('popOutTabFromUi / dockTabFromUi', () => {
	it('pops out in the foreground and shows no toast on success', async () => {
		await popOutTabFromUi(AGENT, { type: 'ai', id: 'a2' });
		expect(api.popOut).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' }, { background: false });
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('shows a pop-out refusal as a toast', async () => {
		await popOutTabFromUi(AGENT, { type: 'ai', id: 'consult' });
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'red',
				message: 'A hidden consult tab cannot be popped out',
			})
		);
	});

	it('docks and shows a refusal from main as a toast', async () => {
		await dockTabFromUi(AGENT, { type: 'ai', id: 'a2' });
		expect(api.dock).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' });
		expect(notifyToast).not.toHaveBeenCalled();
		api.dock.mockResolvedValue({ docked: false, error: 'not popped out' });
		await dockTabFromUi(AGENT, { type: 'ai', id: 'a2' });
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: 'not popped out' })
		);
	});
});

describe('runRemoteTabWindowCommand (maestro-cli tab pop-out / tab dock)', () => {
	it('pops out a tab named by a unique prefix and reports the window and its tabs', async () => {
		seed({ terminalTabs: [{ id: 'term-xyz' }] as never });
		api.list.mockResolvedValue([
			{
				windowId: 'tw-1',
				agentId: AGENT,
				tabRefs: [
					{ type: 'ai', id: 'a1' },
					{ type: 'terminal', id: 'term-xyz' },
				],
				activeTabRef: { type: 'terminal', id: 'term-xyz' },
			},
		]);

		const result = await runRemoteTabWindowCommand({
			action: 'pop-out',
			sessionId: AGENT,
			tabId: 'term-x',
			background: true,
		});

		expect(api.popOut).toHaveBeenCalledWith(
			AGENT,
			{ type: 'terminal', id: 'term-xyz' },
			{ background: true }
		);
		expect(result).toEqual({
			success: true,
			agentId: AGENT,
			tabRef: { type: 'terminal', id: 'term-xyz' },
			windowId: 'tw-1',
			created: true,
			tabRefs: [
				{ type: 'ai', id: 'a1' },
				{ type: 'terminal', id: 'term-xyz' },
			],
		});
	});

	it('pops out in the foreground unless background is set', async () => {
		await runRemoteTabWindowCommand({ action: 'pop-out', sessionId: AGENT, tabId: 'a2' });
		expect(api.popOut).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' }, { background: false });
	});

	it('answers with the same refusal words the UI toasts (TW-14)', async () => {
		const result = await runRemoteTabWindowCommand({
			action: 'pop-out',
			sessionId: AGENT,
			tabId: 'consult',
		});
		expect(result).toEqual({ success: false, error: 'A hidden consult tab cannot be popped out' });
		expect(api.popOut).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('refuses in the web-desktop build (TW-13)', async () => {
		runtime.webDesktop = true;
		const result = await runRemoteTabWindowCommand({
			action: 'pop-out',
			sessionId: AGENT,
			tabId: 'a2',
		});
		expect(result.success).toBe(false);
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('docks a tab and reports an empty strip when that closed the window', async () => {
		const result = await runRemoteTabWindowCommand({
			action: 'dock',
			sessionId: AGENT,
			tabId: 'a2',
		});
		expect(api.dock).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' });
		expect(result).toEqual({
			success: true,
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
			windowId: 'tw-1',
			tabRefs: [],
		});
	});

	it('passes a dock refusal from main through', async () => {
		api.dock.mockResolvedValue({ docked: false, error: 'The agent has no tab window' });
		expect(
			await runRemoteTabWindowCommand({ action: 'dock', sessionId: AGENT, tabId: 'a2' })
		).toEqual({ success: false, error: 'The agent has no tab window' });
	});

	it('refuses an unknown agent, an unknown tab, and an ambiguous prefix', async () => {
		expect(
			await runRemoteTabWindowCommand({ action: 'dock', sessionId: 'ghost', tabId: 'a2' })
		).toEqual({ success: false, error: 'Agent not found: ghost' });
		expect(
			await runRemoteTabWindowCommand({ action: 'dock', sessionId: AGENT, tabId: 'zz' })
		).toEqual({ success: false, error: 'Tab not found: zz' });
		const ambiguous = await runRemoteTabWindowCommand({
			action: 'pop-out',
			sessionId: AGENT,
			tabId: 'a',
		});
		expect(ambiguous.success).toBe(false);
		expect(ambiguous.error).toMatch(/Ambiguous/);
		expect(api.popOut).not.toHaveBeenCalled();
		expect(api.dock).not.toHaveBeenCalled();
	});

	it('still reports the verb as done when the window list fails afterwards', async () => {
		api.list.mockRejectedValue(new Error('list failed'));
		const result = await runRemoteTabWindowCommand({
			action: 'pop-out',
			sessionId: AGENT,
			tabId: 'a2',
		});
		expect(result).toEqual({
			success: true,
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
			windowId: 'tw-1',
			created: true,
			tabRefs: undefined,
		});
		expect(captureException).toHaveBeenCalledTimes(1);
	});

	it('never lists in the renderer', async () => {
		expect((await runRemoteTabWindowCommand({ action: 'list' })).success).toBe(false);
	});
});
