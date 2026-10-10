import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DidYouKnowModal } from '../../../renderer/components/DidYouKnow';
import { LayerStackProvider, useLayerStack } from '../../../renderer/contexts/LayerStackContext';
import { openBrowserTabAt } from '../../../renderer/services/browserTabs';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { buildTipOrder, DID_YOU_KNOW_TIPS } from '../../../shared/didYouKnow';
import { resetStore } from '../../helpers';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/services/browserTabs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../renderer/services/browserTabs')>();
	// Preserve tab creation so Next exercises navigation of the existing docs tab.
	return { ...actual, openBrowserTabAt: vi.fn(actual.openBrowserTabAt) };
});

const order = buildTipOrder(42);

describe('DidYouKnow reading mode', () => {
	beforeEach(() => {
		resetStore(useSettingsStore);
		resetStore(useSessionStore);
		useSettingsStore.setState({ didYouKnowSeed: 42, activeThemeId: 'dracula' });
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'reading-session', browserTabs: [] })],
			activeSessionId: 'reading-session',
		});
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it.each(DID_YOU_KNOW_TIPS)('offers Read more only when $id has a docs page', (tip) => {
		render(<DidYouKnowModal theme={mockTheme} isOpen startTipId={tip.id} onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		if (tip.docsSlug) {
			expect(screen.getByRole('button', { name: 'Read more' })).toBeEnabled();
		} else {
			expect(screen.queryByRole('button', { name: 'Read more' })).not.toBeInTheDocument();
		}
		expect(openBrowserTabAt).not.toHaveBeenCalled();
	});

	it('opens docs without closing, releases lower layers, and restores tips without navigating', () => {
		const onClose = vi.fn();
		const { result } = renderHook(() => useLayerStack(), {
			wrapper: ({ children }) => (
				<LayerStackProvider>
					<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />
					{children}
				</LayerStackProvider>
			),
		});
		const dialog = screen.getByRole('dialog', { name: 'Did You Know' });
		expect(dialog.parentElement).toHaveAttribute('data-reading', 'false');
		expect(result.current.getTopLayer()).toMatchObject({ blocksLowerLayers: true });

		fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
		expect(openBrowserTabAt).toHaveBeenCalledExactlyOnceWith(
			`https://docs.runmaestro.ai/${order[0].docsSlug}?theme=dracula`,
			{ title: order[0].title }
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(dialog).toBeInTheDocument();
		expect(dialog).toHaveAttribute('aria-modal', 'false');
		expect(dialog.parentElement).toHaveAttribute('data-reading', 'true');
		expect(result.current.layerCount).toBe(1);
		expect(result.current.getTopLayer()).toMatchObject({
			blocksLowerLayers: false,
			capturesFocus: false,
			focusTrap: 'none',
			blocksAppShortcuts: false,
		});

		const tabs = useSessionStore.getState().sessions[0].browserTabs;
		fireEvent.click(screen.getByRole('button', { name: 'Back to tips' }));
		expect(dialog.parentElement).toHaveAttribute('data-reading', 'false');
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(screen.getByRole('button', { name: 'Read more' })).toBeEnabled();
		expect(screen.queryByRole('button', { name: 'Back to tips' })).not.toBeInTheDocument();
		expect(screen.getByText(order[0].body[0])).toBeInTheDocument();
		expect(result.current.getTopLayer()).toMatchObject({ blocksLowerLayers: true });
		expect(openBrowserTabAt).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessions[0].browserTabs).toBe(tabs);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('navigates the same docs tab on Next and leaves its page alone for tips without docs', () => {
		const onClose = vi.fn();
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
		const tabId = useSessionStore.getState().sessions[0].activeBrowserTabId;
		expect(tabId).toBeTruthy();
		expect(order.slice(1).some((tip) => !tip.docsSlug)).toBe(true);
		expect(order.slice(1).some((tip) => !!tip.docsSlug)).toBe(true);

		for (const tip of order.slice(1)) {
			const previousTabs = useSessionStore.getState().sessions[0].browserTabs;
			fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
			expect(screen.getByRole('heading', { name: tip.title })).toBeInTheDocument();
			expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-reading', 'true');
			const session = useSessionStore.getState().sessions[0];
			expect(session.activeBrowserTabId).toBe(tabId);
			expect(session.browserTabs).toHaveLength(1);
			if (tip.docsSlug) {
				expect(session.browserTabs![0]).toMatchObject({
					id: tabId,
					title: tip.title,
					url: `https://docs.runmaestro.ai/${tip.docsSlug}?theme=dracula`,
					requestedUrl: `https://docs.runmaestro.ai/${tip.docsSlug}?theme=dracula`,
				});
			} else {
				expect(session.browserTabs).toBe(previousTabs);
			}
			// Neither reusing a docs tab nor a tip without docs opens another tab.
			expect(openBrowserTabAt).toHaveBeenCalledTimes(1);
			expect(onClose).not.toHaveBeenCalled();
		}
	});
});
