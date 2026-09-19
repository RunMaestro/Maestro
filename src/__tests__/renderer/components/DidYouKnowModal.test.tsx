import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DidYouKnowModal } from '../../../renderer/components/DidYouKnow';
import { TIP_ICONS } from '../../../renderer/components/DidYouKnow/TipArtwork';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { buildTipOrder, DID_YOU_KNOW_TIPS } from '../../../shared/didYouKnow';
import { resetStore } from '../../helpers';
import { mockTheme } from '../../helpers/mockTheme';

const order = buildTipOrder(42);

describe('DidYouKnowModal discovery behavior', () => {
	beforeEach(() => {
		// Match DidYouKnow/DidYouKnowModal.test.tsx: reset the real reactive store
		// and use the shared setup's mocked settings bridge for persistence.
		resetStore(useSettingsStore);
		useSettingsStore.setState({ didYouKnowSeed: 42 });
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('opens on the first unseen tip and bounds Back to that card after several Nexts', () => {
		useSettingsStore.setState({ didYouKnowSeenTipIds: [order[0].id, order[1].id] });
		const { rerender } = render(
			<DidYouKnowModal theme={mockTheme} isOpen={false} onClose={vi.fn()} />,
			{ wrapper: LayerStackProvider }
		);
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		rerender(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />);
		expect(screen.getByRole('heading', { name: order[2].title })).toBeInTheDocument();
		const back = screen.getByRole('button', { name: 'Previous tip' });
		const next = screen.getByRole('button', { name: 'Next tip' });
		expect(back).toBeDisabled();
		for (const tip of order.slice(3, 6)) {
			fireEvent.click(next);
			expect(screen.getByRole('heading', { name: tip.title })).toBeInTheDocument();
			expect(back).toBeEnabled();
		}
		for (const tip of order.slice(2, 5).reverse()) {
			fireEvent.click(back);
			expect(screen.getByRole('heading', { name: tip.title })).toBeInTheDocument();
		}
		expect(back).toBeDisabled();
		fireEvent.click(back);
		expect(screen.getByRole('heading', { name: order[2].title })).toBeInTheDocument();
	});

	it('records each displayed tip exactly once across Strict Mode replay and revisits', () => {
		const setSeen = vi.spyOn(useSettingsStore.getState(), 'setDidYouKnowSeenTipIds');
		render(
			<StrictMode>
				<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />
			</StrictMode>,
			{ wrapper: LayerStackProvider }
		);
		expect(setSeen).toHaveBeenCalledExactlyOnceWith([order[0].id]);
		const next = screen.getByRole('button', { name: 'Next tip' });
		fireEvent.click(next);
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
		expect(setSeen).toHaveBeenNthCalledWith(2, [order[0].id, order[1].id]);
		fireEvent.click(next);
		expect(screen.getByRole('heading', { name: order[2].title })).toBeInTheDocument();
		expect(setSeen).toHaveBeenNthCalledWith(
			3,
			order.slice(0, 3).map((tip) => tip.id)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Previous tip' }));
		fireEvent.click(next);
		expect(setSeen).toHaveBeenCalledTimes(3);
		expect(useSettingsStore.getState().didYouKnowSeenTipIds).toEqual(
			order.slice(0, 3).map((tip) => tip.id)
		);
	});

	it('disables discovery and closes when opting out', () => {
		const setEnabled = vi.spyOn(useSettingsStore.getState(), 'setDidYouKnowEnabled');
		const onClose = vi.fn();
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: "Don't show this again" }));
		expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
		expect(useSettingsStore.getState().didYouKnowEnabled).toBe(false);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('uses arrow keys for the same history as Next and Back', () => {
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Previous tip' })).toBeEnabled();
		fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Previous tip' }));
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(screen.getByRole('heading', { name: order[0].title })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Previous tip' })).toBeDisabled();
	});

	it('offers Turn on instead of Open for a disabled Encore feature', () => {
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, maestroCue: false },
		});
		render(
			<DidYouKnowModal theme={mockTheme} isOpen startTipId="maestro-cue" onClose={vi.fn()} />,
			{ wrapper: LayerStackProvider }
		);
		expect(screen.getByRole('button', { name: 'Turn on Maestro Cue' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Open Maestro Cue' })).not.toBeInTheDocument();
	});

	it('fills the frame aperture with an icon plate when the tip has no art', () => {
		const tip = DID_YOU_KNOW_TIPS.find((entry) => !entry.art)!;
		render(<DidYouKnowModal theme={mockTheme} isOpen startTipId={tip.id} onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		const aperture = screen.getByRole('dialog').querySelector('.overflow-hidden > .dyk-art');
		expect(aperture).toBeInTheDocument();
		expect(aperture?.querySelector('svg')).toBeInTheDocument();
		expect(aperture?.querySelector('img')).toBeNull();
	});

	it.each(DID_YOU_KNOW_TIPS)(
		'maps the $id icon explicitly instead of using the fallback',
		(tip) => {
			expect(Object.prototype.hasOwnProperty.call(TIP_ICONS, tip.icon)).toBe(true);
			expect(TIP_ICONS[tip.icon]).toBeDefined();
		}
	);
});
