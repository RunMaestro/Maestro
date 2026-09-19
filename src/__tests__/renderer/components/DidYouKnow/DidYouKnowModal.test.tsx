import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DidYouKnowModal } from '../../../../renderer/components/DidYouKnow';
import { LayerStackProvider, useLayerStack } from '../../../../renderer/contexts/LayerStackContext';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import * as uiSurfaces from '../../../../shared/uiSurfaces';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { buildTipOrder } from '../../../../shared/didYouKnow';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';
import { resetStore } from '../../../helpers';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import { mockTheme } from '../../../helpers/mockTheme';

const order = buildTipOrder(42);

describe('DidYouKnowModal', () => {
	beforeEach(() => {
		resetStore(useSettingsStore);
		resetStore(useModalStore);
		useSettingsStore.setState({ didYouKnowSeed: 42 });
		vi.clearAllMocks();
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

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

	it('navigates with arrows while bounding Back to this session', () => {
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(screen.getByRole('heading', { name: order[0].title })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(screen.getByRole('heading', { name: order[0].title })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
	});

	it('cross-fades only artwork and copy, with direction shared by clicks and keys', () => {
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		const dialog = screen.getByRole('dialog');
		const frame = dialog.querySelector('img[aria-hidden]')!.parentElement!;
		expect(dialog.querySelector('.dyk-enter')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		expect(dialog.querySelectorAll('.dyk-enter')).toHaveLength(2);
		expect(dialog.querySelectorAll('.dyk-exit')).toHaveLength(2);
		for (const entry of dialog.querySelectorAll('.dyk-enter, .dyk-exit')) {
			expect(entry).toHaveAttribute('data-direction', 'next');
		}
		expect(dialog.querySelector('.dyk-copy.dyk-exit')).toHaveAttribute('inert');
		expect(dialog.querySelector('.dyk-copy.dyk-exit')).toHaveAttribute('aria-hidden', 'true');
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		for (const entry of dialog.querySelectorAll('.dyk-enter, .dyk-exit')) {
			expect(entry).toHaveAttribute('data-direction', 'back');
		}
		expect(dialog.querySelector('img[aria-hidden]')!.parentElement).toBe(frame);
		expect(frame).not.toHaveClass('dyk-enter', 'dyk-exit');
		// Reversing again before the animation ends leaves only one outgoing pair.
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(dialog.querySelectorAll('.dyk-exit')).toHaveLength(2);
		expect(dialog.querySelector('.dyk-copy.dyk-enter')).toHaveAttribute('data-tip-id', order[1].id);
	});

	it('reserves every placard in the same grid while exposing only the current copy', () => {
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		const cards = screen.getByRole('dialog').querySelectorAll('.dyk-copy-stack > .dyk-copy');
		expect(cards).toHaveLength(order.length);
		expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
		for (const card of cards) {
			if (card.getAttribute('data-tip-id') === order[0].id) continue;
			expect(card).toHaveAttribute('aria-hidden', 'true');
			expect(card).toHaveAttribute('inert');
			expect(card).toHaveStyle({ visibility: 'hidden' });
		}
		expect(useSettingsStore.getState().didYouKnowSeenTipIds).toEqual([order[0].id]);
	});

	it('skips both transition layers when reduced motion is requested, including after opening', () => {
		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		const matchMedia = vi.spyOn(window, 'matchMedia');
		matchMedia.mockReturnValue({ ...media, matches: false });
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		matchMedia.mockReturnValue({ ...media, matches: true });
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
		expect(screen.getByRole('heading', { name: order[0].title })).toBeInTheDocument();
		expect(screen.getByRole('dialog').querySelector('.dyk-enter, .dyk-exit')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
		expect(screen.getByRole('dialog').querySelector('.dyk-enter, .dyk-exit')).toBeNull();
	});

	it('uses Enter for the current primary action and leaves actionless tips alone', () => {
		const openModal = vi.spyOn(useModalStore.getState(), 'openModal');
		const onClose = vi.fn();
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, maestroCue: false },
		});
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(screen.queryByRole('button', { name: /^(Open|Turn on) / })).toBeNull();
		expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(true);
		expect(openModal).not.toHaveBeenCalled();
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(false);
		expect(useSettingsStore.getState().encoreFeatures.maestroCue).toBe(true);
		expect(onClose).toHaveBeenCalledOnce();
		expect(openModal).toHaveBeenCalledExactlyOnceWith('cueModal');
	});

	it('yields arrows, Enter, and Escape to a higher layer, then resumes after removal', async () => {
		const onClose = vi.fn();
		const onEscape = vi.fn();
		const { result } = renderHook(() => useLayerStack(), {
			wrapper: ({ children }) => (
				<LayerStackProvider>
					<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />
					{children}
				</LayerStackProvider>
			),
		});
		let layerId: string;
		act(() => {
			layerId = result.current.registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.DID_YOU_KNOW + 1,
				onEscape,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'none',
			});
		});
		for (const key of ['ArrowLeft', 'ArrowRight', 'Enter']) {
			expect(fireEvent.keyDown(window, { key })).toBe(true);
		}
		expect(screen.getByRole('heading', { name: order[0].title })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(onEscape).toHaveBeenCalledOnce());
		expect(onClose).not.toHaveBeenCalled();
		act(() => result.current.unregisterLayer(layerId));
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(screen.getByRole('heading', { name: order[1].title })).toBeInTheDocument();
	});

	it('ignores modified, composing, prevented, and text-entry keys and cleans up on close', () => {
		const onClose = vi.fn();
		const { rerender } = render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		for (const options of [
			{ ctrlKey: true },
			{ metaKey: true },
			{ altKey: true },
			{ shiftKey: true },
			{ isComposing: true },
		]) {
			expect(fireEvent.keyDown(window, { key: 'ArrowRight', ...options })).toBe(true);
		}
		const prevented = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
		prevented.preventDefault();
		fireEvent(window, prevented);
		const input = document.createElement('input');
		screen.getByRole('dialog').append(input);
		fireEvent.keyDown(input, { key: 'ArrowRight' });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(screen.getByRole('heading', { name: order[0].title })).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		rerender(<DidYouKnowModal theme={mockTheme} isOpen={false} onClose={onClose} />);
		expect(fireEvent.keyDown(window, { key: 'ArrowRight' })).toBe(true);
		expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
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
		expect(screen.getByRole('button', { name: 'Turn on Maestro Cue' })).toBeEnabled();
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
		expect(screen.getByRole('button', { name: 'Open Maestro Cue' })).toBeEnabled();
		fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		expect(screen.queryByRole('button', { name: 'Open Maestro Cue' })).toBeNull();
		const withoutDocsIndex = order.findIndex((tip) => !tip.docsSlug);
		expect(withoutDocsIndex).toBeGreaterThan(1);
		for (let index = 1; index < withoutDocsIndex; index++) {
			fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
		}
		expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
	});

	it('enables the Encore flag without resetting others, then closes before opening', () => {
		const features = {
			...useSettingsStore.getState().encoreFeatures,
			maestroCue: false,
			directorNotes: true,
			symphony: true,
		};
		useSettingsStore.setState({ encoreFeatures: features });
		const openModal = vi.spyOn(useModalStore.getState(), 'openModal');
		const onClose = vi.fn(() => {
			expect(useSettingsStore.getState().encoreFeatures.maestroCue).toBe(true);
			expect(openModal).not.toHaveBeenCalled();
		});
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Turn on Maestro Cue' }));
		expect(useSettingsStore.getState().encoreFeatures).toEqual({ ...features, maestroCue: true });
		expect(window.maestro.settings.set).toHaveBeenCalledWith('encoreFeatures', {
			...features,
			maestroCue: true,
		});
		expect(onClose).toHaveBeenCalledOnce();
		expect(openModal).toHaveBeenCalledExactlyOnceWith('cueModal');
	});

	it('opens an enabled Encore surface without rewriting settings', () => {
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, maestroCue: true },
		});
		const setEncoreFeatures = vi.spyOn(useSettingsStore.getState(), 'setEncoreFeatures');
		const openModal = vi.spyOn(useModalStore.getState(), 'openModal');
		const onClose = vi.fn(() => expect(openModal).not.toHaveBeenCalled());
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Open Maestro Cue' }));
		expect(setEncoreFeatures).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledOnce();
		expect(openModal).toHaveBeenCalledExactlyOnceWith('cueModal');
	});

	it('uses the registered label and modal id for a regular surface', () => {
		const tip = order.find((entry) => entry.surface === 'shortcuts')!;
		const openModal = vi.spyOn(useModalStore.getState(), 'openModal');
		const onClose = vi.fn(() => expect(openModal).not.toHaveBeenCalled());
		render(<DidYouKnowModal theme={mockTheme} isOpen startTipId={tip.id} onClose={onClose} />, {
			wrapper: LayerStackProvider,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Open Keyboard Shortcuts' }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(openModal).toHaveBeenCalledExactlyOnceWith('shortcutsHelp');
	});

	it.each(['missing', 'blocked'] as const)('hides the action for a %s surface', (kind) => {
		const cue = uiSurfaces.resolveUiSurface('cue')!;
		vi.spyOn(uiSurfaces, 'resolveUiSurface').mockReturnValue(
			kind === 'missing' ? null : { ...cue, encore: 'symphony' }
		);
		useSettingsStore.setState({
			encoreFeatures: {
				...useSettingsStore.getState().encoreFeatures,
				maestroCue: false,
				symphony: false,
			},
		});
		render(<DidYouKnowModal theme={mockTheme} isOpen onClose={vi.fn()} />, {
			wrapper: LayerStackProvider,
		});
		expect(screen.queryByRole('button', { name: /^(Open|Turn on) / })).toBeNull();
	});
});
