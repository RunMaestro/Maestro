import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { render } from '@testing-library/react';
import { BusyWand } from '../../../../renderer/components/SessionList/BusyWand';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { HamburgerMenuContent } from '../../../../renderer/components/SessionList/HamburgerMenuContent';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../../renderer/stores/throughputGaugeStore';
import { mockTheme } from '../../../helpers/mockTheme';
__maestroMicrobenchDescribe('BusyWand', () => {
	/**
	 * The glints are composited overlay ELEMENTS, so unlike a pure-CSS animation
	 * their presence is a render decision and can regress silently. These lock the
	 * three rules that decision follows.
	 */
	describe('BusyWand', () => {
		const glints = (container: HTMLElement) => container.querySelectorAll('.wand-glint');

		it('renders no glints at rest', () => {
			const { container } = render(
				<BusyWand busy={false} profiling={false} sizeClass="w-5 h-5" color="#fff" />
			);
			expect(glints(container)).toHaveLength(0);
			expect(container.querySelector('.wand-sparkle-active')).toBeNull();
		});

		it('renders the glints and the breathe class while busy', () => {
			const { container } = render(
				<BusyWand busy profiling={false} sizeClass="w-5 h-5" color="#fff" />
			);
			expect(glints(container)).toHaveLength(3);
			expect(container.querySelector('svg.wand-sparkle-active')).not.toBeNull();
		});

		// Two competing signals at once reads as noise, and profiling is the state
		// the user did not ask for and may want to turn off.
		it('suppresses the glints while profiling, keeping the red pulse', () => {
			const { container } = render(<BusyWand busy profiling sizeClass="w-5 h-5" color="#fff" />);
			expect(glints(container)).toHaveLength(0);
			expect(container.querySelector('svg.wand-profiling-active')).not.toBeNull();
		});

		it('puts the color on the wrapper so the currentColor glints inherit it', () => {
			const { container } = render(
				<BusyWand busy profiling={false} sizeClass="w-5 h-5" color="rgb(145, 70, 255)" />
			);
			const wrapper = container.querySelector('.wand-glints') as HTMLElement;
			expect(wrapper.style.color).toBe('rgb(145, 70, 255)');
		});

		it('hides the decorative glints from assistive tech', () => {
			const { container } = render(
				<BusyWand busy profiling={false} sizeClass="w-5 h-5" color="#fff" />
			);
			for (const glint of glints(container)) {
				expect(glint.getAttribute('aria-hidden')).toBe('true');
			}
		});
	});
});
__maestroMicrobenchDescribe('HamburgerMenuContent', () => {
	function renderMenu(setMenuOpen = vi.fn()) {
		return render(
			<HamburgerMenuContent
				theme={mockTheme}
				onNewAgentSession={vi.fn()}
				openWizard={vi.fn()}
				startTour={vi.fn()}
				setMenuOpen={setMenuOpen}
			/>
		);
	}

	function setGaugeFlag(on: boolean) {
		useSettingsStore.setState((s) => ({
			encoreFeatures: { ...s.encoreFeatures, throughputGauge: on },
		}));
	}

	describe('HamburgerMenuContent - Throughput Gauge', () => {
		const initialEncore = useSettingsStore.getState().encoreFeatures;

		beforeEach(() => {
			useThroughputGaugeStore.setState({ visible: false });
		});

		afterEach(() => {
			useSettingsStore.setState({ encoreFeatures: initialEncore });
		});

		it('leaves the item out while the Encore Feature is off', () => {
			setGaugeFlag(false);
			renderMenu();
			expect(screen.queryByText('Throughput Gauge')).not.toBeInTheDocument();
		});

		it('toggles the gauge and closes the menu while the Encore Feature is on', () => {
			setGaugeFlag(true);
			const closeMenu = vi.fn();
			renderMenu(closeMenu);

			fireEvent.click(screen.getByRole('button', { name: /Throughput Gauge/ }));
			expect(useThroughputGaugeStore.getState().visible).toBe(true);
			expect(closeMenu).toHaveBeenCalledWith(false);

			fireEvent.click(screen.getByRole('button', { name: /Throughput Gauge/ }));
			expect(useThroughputGaugeStore.getState().visible).toBe(false);
		});
	});
});
