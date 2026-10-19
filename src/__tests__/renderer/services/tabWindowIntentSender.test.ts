/**
 * Tests for services/tabWindowIntentSender, and for the shared services that
 * use it to hand their action to the owner window when they run in a tab
 * window (Tab Windows, D1: a tab window writes no Session and starts nothing).
 *
 * The shell card's Stop, a `maestro://` link, and a link opened in Maestro's
 * browser run deep inside reused components that know neither the agent nor
 * the tab. In an app window they act on the active agent; in a tab window they
 * must become an intent for the tab the window shows, and must NOT also run
 * here (a browser tab created here would exist only in this window's copy).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runtime = vi.hoisted(() => ({ tabWindow: true }));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isTabWindow: () => runtime.tabWindow,
}));

import { sendShownTabIntent } from '../../../renderer/services/tabWindowIntentSender';
import { cancelShellCommand } from '../../../renderer/services/shellCommand';
import { openMaestroLink } from '../../../renderer/utils/openMaestroLink';
import { openInMaestroBrowser } from '../../../renderer/utils/openUrl';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { installTabWindowsApi } from '../../helpers/tabWindows';

let api: ReturnType<typeof installTabWindowsApi>;

beforeEach(() => {
	runtime.tabWindow = true;
	api = installTabWindowsApi();
	// A tab window's store: its one agent, active, with the shown AI tab active.
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 'agent-1',
				aiTabs: [createMockAITab({ id: 'shown' })],
				activeTabId: 'shown',
				browserTabs: [],
			}),
		],
		activeSessionId: 'agent-1',
	});
});

afterEach(() => {
	api.restore();
});

const envelope = { agentId: 'agent-1', tabRef: { type: 'ai', id: 'shown' } };

describe('sendShownTabIntent', () => {
	it('sends the intent for the AI tab the window shows', () => {
		expect(sendShownTabIntent('cancelShellCommand', { logId: 'l1' })).toBe(true);
		expect(api.sendIntent).toHaveBeenCalledWith({
			kind: 'cancelShellCommand',
			...envelope,
			logId: 'l1',
		});
	});

	it('claims the action in a tab window even with no tab shown yet (it is never run here)', () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		expect(sendShownTabIntent('cancelShellCommand', { logId: 'l1' })).toBe(true);
		expect(api.sendIntent).not.toHaveBeenCalled();
	});

	it('leaves the action to the caller outside a tab window', () => {
		runtime.tabWindow = false;
		expect(sendShownTabIntent('cancelShellCommand', { logId: 'l1' })).toBe(false);
		expect(api.sendIntent).not.toHaveBeenCalled();
	});
});

describe('services that run in a tab window hand their action to the owner', () => {
	it("the shell card's Stop: cancelShellCommand", async () => {
		await expect(cancelShellCommand('shell-1')).resolves.toBe(true);
		expect(api.sendIntent).toHaveBeenCalledWith({
			kind: 'cancelShellCommand',
			...envelope,
			logId: 'shell-1',
		});
	});

	it('a maestro:// link: openMaestroLink sends navigate and dispatches nothing here', () => {
		const heard = vi.fn();
		window.addEventListener('maestro:in-app-deep-link', heard);
		try {
			expect(openMaestroLink('maestro://session/agent-2')).toBe(true);
			expect(api.sendIntent).toHaveBeenCalledWith({
				kind: 'navigate',
				...envelope,
				deepLink: 'maestro://session/agent-2',
			});
			expect(heard).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener('maestro:in-app-deep-link', heard);
		}
	});

	it("a link for Maestro's browser: no browser tab is created in this window's copy", () => {
		openInMaestroBrowser('https://example.com');
		expect(api.sendIntent).toHaveBeenCalledWith({
			kind: 'openUrlInMaestro',
			...envelope,
			url: 'https://example.com',
		});
		expect(useSessionStore.getState().sessions[0].browserTabs).toEqual([]);
	});
});
