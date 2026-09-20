import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BusyWand } from '../../../../renderer/components/SessionList/BusyWand';

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
