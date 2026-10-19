/**
 * The renderer half of the Tab Windows terminal handoff (D5). The protocol's
 * ordering is covered end to end in `XTerminal.handoff.test.tsx`; these cover
 * the edges: no tab windows API, a main process that never answers, and a
 * claim withdrawn before its answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TERMINAL_CLAIM_TIMEOUT_MS,
	TERMINAL_RELEASE_TIMEOUT_MS,
	claimTerminalReplay,
	registerTerminalViewForUnload,
	releaseRegisteredTerminalViews,
	releaseTerminalView,
	resetTerminalHandoffForTests,
} from '../../../renderer/services/terminalHandoff';
import { installTerminalHandoffApi, type TerminalHandoffApiDouble } from '../../helpers/tabWindows';

const PTY = 'agent-1-terminal-term-1';

describe('terminalHandoff (renderer)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetTerminalHandoffForTests();
		window.maestro.process.onData = vi.fn(() => () => {}) as never;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('without a tab windows API (web-desktop, TW-13)', () => {
		it('answers a claim with null at once, and a release does nothing', () => {
			const onReplay = vi.fn();
			claimTerminalReplay(PTY, onReplay);
			expect(onReplay).toHaveBeenCalledWith(null);

			expect(() => releaseTerminalView(PTY, { buffer: 'x', unparsed: [] })).not.toThrow();
			expect(() => releaseRegisteredTerminalViews()).not.toThrow();
		});
	});

	describe('with the API', () => {
		let api: TerminalHandoffApiDouble;

		beforeEach(() => {
			api = installTerminalHandoffApi();
		});

		afterEach(() => api.restore());

		it('goes live when main never answers a claim', () => {
			const onReplay = vi.fn();
			claimTerminalReplay(PTY, onReplay);

			vi.advanceTimersByTime(TERMINAL_CLAIM_TIMEOUT_MS);

			expect(onReplay).toHaveBeenCalledWith(null);
			// A later answer finds nobody waiting.
			api.emitReplay(PTY, 'late');
			expect(onReplay).toHaveBeenCalledTimes(1);
		});

		it('drops a listener that withdrew, and answers the ones still waiting', () => {
			const gone = vi.fn();
			const waiting = vi.fn();
			const cancel = claimTerminalReplay(PTY, gone);
			claimTerminalReplay(PTY, waiting);
			cancel();

			api.emitReplay(PTY, 'replay');

			expect(gone).not.toHaveBeenCalled();
			expect(waiting).toHaveBeenCalledWith('replay');
			expect(api.claimTerminalReplay).toHaveBeenCalledTimes(1);
		});

		it('claims again once the previous claim was answered', () => {
			claimTerminalReplay(PTY, vi.fn());
			api.emitReplay(PTY, null);
			claimTerminalReplay(PTY, vi.fn());

			expect(api.claimTerminalReplay).toHaveBeenCalledTimes(2);
		});

		it('commits a release anyway when main never answers it', () => {
			releaseTerminalView(PTY, { buffer: 'a\nb', unparsed: ['c'] });
			expect(api.commitTerminalRelease).not.toHaveBeenCalled();

			vi.advanceTimersByTime(TERMINAL_RELEASE_TIMEOUT_MS);

			expect(api.commitTerminalRelease).toHaveBeenCalledWith(PTY, 'a\r\nbc');
			// Main's late answer commits nothing twice.
			api.emitReleaseBegun(PTY);
			expect(api.commitTerminalRelease).toHaveBeenCalledTimes(1);
		});

		it('releases each registered view once on unload, and none that unregistered', () => {
			const unregister = registerTerminalViewForUnload('agent-1-terminal-gone', () => ({
				buffer: 'gone',
				unparsed: [],
			}));
			registerTerminalViewForUnload(PTY, () => ({ buffer: '$ vim', unparsed: [] }));
			unregister();

			releaseRegisteredTerminalViews();
			releaseRegisteredTerminalViews();

			expect(api.commitTerminalRelease).toHaveBeenCalledTimes(1);
			expect(api.commitTerminalRelease).toHaveBeenCalledWith(PTY, '$ vim');
		});
	});
});
