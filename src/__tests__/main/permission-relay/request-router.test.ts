/**
 * Tests for the permission relay's request router: which window prompts the
 * user, and what happens to a prompt left waiting in a tab window whose tab
 * docks (Tab Windows).
 *
 * A request for a popped-out tab is answered in its tab window, where the user
 * is looking at it. One left there when the tab docks (or the window closes)
 * must move to the window that shows the tab now: otherwise the agent waits out
 * the relay's five-minute timeout and gets a deny it never asked for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { createPermissionRequestRouter } from '../../../main/permission-relay/request-router';
import type { PermissionRequest } from '../../../main/permission-relay/types';

function makeWindow(): BrowserWindow {
	let destroyed = false;
	return {
		isDestroyed: () => destroyed,
		webContents: { isDestroyed: () => destroyed },
		destroy: () => {
			destroyed = true;
		},
	} as unknown as BrowserWindow;
}

function request(requestId: string, tabId = 'tab-1'): PermissionRequest {
	return {
		requestId,
		token: 'token',
		sessionId: `agent-1-ai-${tabId}`,
		tabId,
		toolName: 'Bash',
		input: { command: 'ls' },
		createdAt: 0,
	};
}

describe('createPermissionRequestRouter', () => {
	let mainWindow: BrowserWindow;
	let tabWindow: BrowserWindow;
	/** Which tab ids the tab window holds right now. */
	let popped: Set<string>;
	let pending: Set<string>;
	let send: ReturnType<typeof vi.fn>;

	function router() {
		return createPermissionRequestRouter({
			getMainWindow: () => mainWindow,
			resolveTabWindow: (req) => (req.tabId && popped.has(req.tabId) ? tabWindow : null),
			isPending: (id) => pending.has(id),
			send,
		});
	}

	beforeEach(() => {
		mainWindow = makeWindow();
		tabWindow = makeWindow();
		popped = new Set(['tab-1']);
		pending = new Set(['r1', 'r2']);
		send = vi.fn();
	});

	it("prompts in the tab window that shows the request's tab", () => {
		const delivery = router().deliver(request('r1'));
		expect(delivery).toEqual({ delivered: true, window: tabWindow });
		expect(send).toHaveBeenCalledWith(tabWindow, request('r1'));
	});

	it('prompts in the main window for a tab that is not popped out', () => {
		const delivery = router().deliver(request('r1', 'tab-2'));
		expect(delivery).toEqual({ delivered: true, window: mainWindow });
	});

	it('falls back to the main window when the tab window is gone', () => {
		(tabWindow as unknown as { destroy: () => void }).destroy();
		expect(router().deliver(request('r1')).delivered).toBe(true);
		expect(send).toHaveBeenCalledWith(mainWindow, expect.anything());
	});

	it('reports a request no window can take, or a send that throws', () => {
		(mainWindow as unknown as { destroy: () => void }).destroy();
		popped.clear();
		expect(router().deliver(request('r1'))).toEqual({
			delivered: false,
			reason: 'no window to prompt',
		});

		mainWindow = makeWindow();
		send.mockImplementation(() => {
			throw new Error('render process gone');
		});
		expect(router().deliver(request('r2'))).toEqual({
			delivered: false,
			reason: 'render process gone',
		});
	});

	it('moves a waiting prompt to the main window when its tab docks', () => {
		const r = router();
		r.deliver(request('r1'));
		send.mockClear();

		popped.delete('tab-1');
		expect(r.reroute()).toEqual({ moved: ['r1'], failed: [] });
		expect(send).toHaveBeenCalledWith(mainWindow, request('r1'));

		// Re-routed once: a later change does not send it again.
		send.mockClear();
		expect(r.reroute()).toEqual({ moved: [], failed: [] });
		expect(send).not.toHaveBeenCalled();
	});

	it('moves a waiting prompt when its tab window closes', () => {
		const r = router();
		r.deliver(request('r1'));
		(tabWindow as unknown as { destroy: () => void }).destroy();
		popped.clear();

		expect(r.reroute().moved).toEqual(['r1']);
		expect(send).toHaveBeenLastCalledWith(mainWindow, request('r1'));
	});

	it('leaves a prompt alone while its tab stays in its tab window', () => {
		const r = router();
		r.deliver(request('r1'));
		send.mockClear();

		expect(r.reroute()).toEqual({ moved: [], failed: [] });
		expect(send).not.toHaveBeenCalled();
	});

	it('never moves a prompt out of the main window (one request, one window)', () => {
		const r = router();
		r.deliver(request('r1', 'tab-2'));
		send.mockClear();

		// The tab pops out after the prompt was shown in the main window.
		popped.add('tab-2');
		expect(r.reroute()).toEqual({ moved: [], failed: [] });
		expect(send).not.toHaveBeenCalled();
	});

	it('forgets a request that was answered, timed out, or cleaned up', () => {
		const r = router();
		r.deliver(request('r1'));
		r.deliver(request('r2'));
		r.settle('r1');
		pending.delete('r2');
		send.mockClear();

		popped.clear();
		expect(r.reroute()).toEqual({ moved: [], failed: [] });
		expect(send).not.toHaveBeenCalled();
	});

	it('reports a stranded prompt no window can take', () => {
		const r = router();
		r.deliver(request('r1'));
		popped.clear();
		(mainWindow as unknown as { destroy: () => void }).destroy();

		expect(r.reroute()).toEqual({ moved: [], failed: ['r1'] });
	});
});
