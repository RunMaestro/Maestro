import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDidYouKnowRotation } from '../../../../renderer/components/DidYouKnow/useDidYouKnowRotation';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import * as tipRegistry from '../../../../shared/didYouKnow';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { createMockSession } from '../../../helpers/mockSession';
import { buildMaestroUrl } from '../../../../renderer/utils/buildMaestroUrl';
import { buildTipOrder } from '../../../../shared/didYouKnow';
import { resetStore } from '../../../helpers';

vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));

describe('useDidYouKnowRotation', () => {
	beforeEach(() => {
		resetStore(useSettingsStore);
		resetStore(useSessionStore);
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'session-1', browserTabs: [] })],
			activeSessionId: 'session-1',
		});
		useSettingsStore.setState({ didYouKnowSeed: 42 });
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('opens themed docs once and reuses the tab for Next, Back, and forward history', () => {
		const { result, rerender } = renderHook(() => useDidYouKnowRotation({}), {
			wrapper: StrictMode,
		});
		expect(result.current.isReading).toBe(false);
		expect(useSessionStore.getState().sessions[0].browserTabs).toHaveLength(0);
		const first = result.current.tip!;
		act(() => result.current.openDocs());
		expect(result.current.isReading).toBe(true);
		const opened = useSessionStore.getState().sessions[0].browserTabs![0];
		expect(opened).toMatchObject({
			url: buildMaestroUrl(`https://docs.runmaestro.ai/${first.docsSlug}`),
			title: first.title,
		});
		act(() => result.current.goNext());
		const next = result.current.tip!;
		expect(useSessionStore.getState().sessions[0].browserTabs).toEqual([
			expect.objectContaining({
				id: opened.id,
				title: next.title,
				requestedUrl: buildMaestroUrl(`https://docs.runmaestro.ai/${next.docsSlug}`),
			}),
		]);
		act(() => result.current.goBack());
		expect(useSessionStore.getState().sessions[0].browserTabs![0].title).toBe(first.title);
		act(() => result.current.goNext());
		expect(useSessionStore.getState().sessions[0].browserTabs![0].title).toBe(next.title);
		rerender();
		expect(useSessionStore.getState().sessions[0].browserTabs).toHaveLength(1);
		const beforeExit = useSessionStore.getState().sessions;
		act(() => result.current.exitReading());
		expect(result.current.isReading).toBe(false);
		act(() => result.current.goNext());
		act(() => result.current.goBack());
		expect(useSessionStore.getState().sessions).toBe(beforeExit);
	});

	it('leaves the docs page untouched and explains tips without docs in either direction', () => {
		const order = buildTipOrder(42).map((tip, index) =>
			index === 1 ? { ...tip, docsSlug: undefined } : tip
		);
		vi.spyOn(tipRegistry, 'buildTipOrder').mockReturnValue(order);
		const { result } = renderHook(() => useDidYouKnowRotation({}));
		act(() => result.current.openDocs());
		const before = useSessionStore.getState().sessions;
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[1].id);
		expect(result.current.isReading).toBe(true);
		expect(useSessionStore.getState().sessions).toBe(before);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: order[1].title,
				message: expect.stringContaining('browser stays on the last page'),
			})
		);
		act(() => result.current.goNext());
		const afterNext = useSessionStore.getState().sessions;
		act(() => result.current.goBack());
		expect(useSessionStore.getState().sessions).toBe(afterNext);
		expect(notifyToast).toHaveBeenCalledTimes(2);
	});

	it('does not enter reading mode or open a blank tab when the tip has no docs', () => {
		vi.spyOn(tipRegistry, 'buildTipOrder').mockReturnValue(
			buildTipOrder(42).map((tip) => ({ ...tip, docsSlug: undefined }))
		);
		const { result } = renderHook(() => useDidYouKnowRotation({}));
		act(() => result.current.openDocs());
		expect(result.current.isReading).toBe(false);
		expect(useSessionStore.getState().sessions[0].browserTabs).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledOnce();
	});

	it('replaces a closed reading tab without touching unrelated browser tabs', () => {
		const { result } = renderHook(() => useDidYouKnowRotation({}));
		act(() => result.current.openDocs());
		const session = useSessionStore.getState().sessions[0];
		const unrelated = { ...session.browserTabs![0], id: 'unrelated' };
		act(() =>
			useSessionStore.setState({
				sessions: [{ ...session, browserTabs: [unrelated], activeBrowserTabId: unrelated.id }],
			})
		);
		act(() => result.current.goNext());
		const tabs = useSessionStore.getState().sessions[0].browserTabs!;
		expect(tabs).toHaveLength(2);
		expect(tabs[0]).toBe(unrelated);
		expect(tabs[1].title).toBe(result.current.tip!.title);
	});

	it('resumes at the first unseen tip and persists it immediately', () => {
		const order = buildTipOrder(42);
		useSettingsStore.setState({ didYouKnowSeenTipIds: [order[0].id, 'retired-tip'] });
		const { result } = renderHook(() => useDidYouKnowRotation({}));
		expect(result.current.tip).toEqual(order[1]);
		expect(result.current.index).toBe(2);
		expect(result.current.total).toBe(order.length);
		expect(result.current.canGoBack).toBe(false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('didYouKnowSeenTipIds', [
			order[0].id,
			'retired-tip',
			order[1].id,
		]);
	});

	it('bounds Back to the session and replays forward history before picking another tip', () => {
		const order = buildTipOrder(42);
		const { result } = renderHook(() => useDidYouKnowRotation({ startTipId: order[7].id }));
		expect(result.current.index).toBe(8);
		act(() => result.current.goBack());
		expect(result.current.tip?.id).toBe(order[7].id);
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[0].id);
		expect(result.current.canGoBack).toBe(true);
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[1].id);
		act(() => result.current.goBack());
		act(() => result.current.goBack());
		expect(result.current.canGoBack).toBe(false);
		vi.clearAllMocks();
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[0].id);
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[1].id);
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[2].id);
	});

	it('wraps in library order once all tips have been seen', () => {
		const order = buildTipOrder(42);
		useSettingsStore.setState({ didYouKnowSeenTipIds: order.map((tip) => tip.id) });
		const { result } = renderHook(() =>
			useDidYouKnowRotation({ startTipId: order[order.length - 1].id })
		);
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[0].id);
		act(() => result.current.goNext());
		expect(result.current.tip?.id).toBe(order[1].id);
	});

	it.each([0, 0.5, 0.9999999999])(
		'persists a generated seed once under Strict Mode (%s)',
		(random) => {
			useSettingsStore.setState({ didYouKnowSeed: 0 });
			vi.spyOn(Math, 'random').mockReturnValue(random);
			const { result, rerender } = renderHook(() => useDidYouKnowRotation({}), {
				wrapper: StrictMode,
			});
			rerender();
			const seed = Math.floor(random * 2 ** 32);
			expect(useSettingsStore.getState().didYouKnowSeed).toBe(seed);
			expect(
				vi
					.mocked(window.maestro.settings.set)
					.mock.calls.filter(([key]) => key === 'didYouKnowSeed')
			).toEqual([['didYouKnowSeed', seed]]);
			expect(
				vi
					.mocked(window.maestro.settings.set)
					.mock.calls.filter(([key]) => key === 'didYouKnowSeenTipIds')
			).toHaveLength(1);
			expect(result.current.tip).toEqual(buildTipOrder(seed)[0]);
		}
	);

	it('preserves an existing seed and resumes after an unmount without needing a close action', () => {
		const first = renderHook(() => useDidYouKnowRotation({}));
		act(() => first.result.current.goNext());
		act(() => first.result.current.goNext());
		first.unmount();
		const second = renderHook(() => useDidYouKnowRotation({}));
		expect(second.result.current.index).toBe(4);
		expect(second.result.current.canGoBack).toBe(false);
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
			'didYouKnowSeed',
			expect.anything()
		);
	});

	it('appends distinct seen ids without losing consecutive writes', () => {
		const { result } = renderHook(() => useDidYouKnowRotation({}));
		act(() => {
			result.current.markSeen('auto-run');
			result.current.markSeen('group-chat');
			result.current.markSeen('auto-run');
		});
		expect(useSettingsStore.getState().didYouKnowSeenTipIds).toEqual([
			'maestro-cue',
			'auto-run',
			'group-chat',
		]);
	});

	it('falls back for a stale start id and treats startTipId as an initial value', () => {
		const { result, rerender } = renderHook(
			({ startTipId }) => useDidYouKnowRotation({ startTipId }),
			{ initialProps: { startTipId: 'retired-tip' } }
		);
		expect(result.current.index).toBe(1);
		rerender({ startTipId: 'remote-agents' });
		expect(result.current.index).toBe(1);
	});

	it('persists the opt out without changing the displayed tip or history', () => {
		const { result } = renderHook(() => useDidYouKnowRotation({}));
		const tip = result.current.tip;
		act(() => result.current.dismissForever());
		expect(useSettingsStore.getState().didYouKnowEnabled).toBe(false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('didYouKnowEnabled', false);
		expect(result.current.tip).toBe(tip);
		expect(result.current.canGoBack).toBe(false);
	});
});
