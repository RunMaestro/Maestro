import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DidYouKnowModal } from '../../../../renderer/components/DidYouKnow';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { buildTipOrder } from '../../../../shared/didYouKnow';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';
import { resetStore } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const order = buildTipOrder(42);

describe('DidYouKnowModal', () => {
	beforeEach(() => {
		resetStore(useSettingsStore);
		useSettingsStore.setState({ didYouKnowSeed: 42 });
		vi.clearAllMocks();
	});
	afterEach(cleanup);

	it('does not render, persist seen tips, or capture Escape while closed', () => {
		const onClose = vi.fn();
		render(<DidYouKnowModal theme={mockTheme} isOpen={false} onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(useSettingsStore.getState().didYouKnowSeenTipIds).toEqual([]);
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();
	});

	it('portals the frame and placard with a stable disabled Back control', () => {
		const { container } = render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		expect(container).toBeEmptyDOMElement();
		const dialog = screen.getByRole('dialog', { name: 'Did You Know' });
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog.parentElement).toHaveClass('select-none');
		expect(dialog.querySelector('img')).toHaveAttribute('aria-hidden', 'true');
		expect(screen.getByText(`1 of ${order.length}`)).toBeInTheDocument();
		const back = screen.getByRole('button', { name: 'Previous tip' });
		expect(back).toBeDisabled();
		fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
		expect(back).toBeEnabled();
		fireEvent.click(back);
		expect(screen.getByRole('heading', { name: order[0].title })).toBeInTheDocument();
		expect(back).toBeDisabled();
	});

	it('starts a new session with startTipId after closing and reopening', () => {
		const onClose = vi.fn();
		const { rerender } = render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		rerender(<DidYouKnowModal theme={mockTheme} isOpen={false} onClose={onClose} />);
		rerender(
			<DidYouKnowModal theme={mockTheme} isOpen startTipId={order[3].id} onClose={onClose} />
		);
		expect(screen.getByRole('heading', { name: order[3].title })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Previous tip' })).toBeDisabled();
	});

	it('closes through both the shared button and the layer Escape handler', async () => {
		const onClose = vi.fn();
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
	});

	it('persists permanent dismissal through rotation and closes', () => {
		const onClose = vi.fn();
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: "Don't show this again" }));
		expect(useSettingsStore.getState().didYouKnowEnabled).toBe(false);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('passes live presentation settings to the copy and shows only applicable actions', () => {
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, maestroCue: false },
		});
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		expect(screen.getByText('Encore')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Turn on Maestro Cue' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Read more' })).toBeDisabled();
		const binding = { id: 'openCue', label: 'Cue', keys: ['Alt', 'j'] };
		act(() =>
			useSettingsStore.setState({
				shortcuts: { openCue: binding },
				encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, maestroCue: true },
			})
		);
		expect(screen.getByText(formatShortcutKeys(binding.keys))).toBeInTheDocument();
		expect(screen.queryByText('Encore')).toBeNull();
		expect(screen.getByRole('button', { name: 'Open Maestro Cue' })).toBeDisabled();
		fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		expect(screen.queryByRole('button', { name: 'Open Maestro Cue' })).toBeNull();
		const withoutDocsIndex = order.findIndex((tip) => !tip.docsSlug);
		expect(withoutDocsIndex).toBeGreaterThan(1);
		for (let index = 1; index < withoutDocsIndex; index++) {
			fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		}
		expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
	});
});
