// Source: src/__tests__/renderer/components/PlaygroundPanel/components/PlaygroundHeaderTabs.test.tsx
// Source: src/__tests__/renderer/components/PlaygroundPanel/components/BatonView.test.tsx
// Source: src/__tests__/renderer/components/PlaygroundPanel/components/ConfettiView.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { PlaygroundHeader } from '../../../../../renderer/components/PlaygroundPanel/components';
import { PlaygroundTabs } from '../../../../../renderer/components/PlaygroundPanel/components';
import { mockTheme } from '../_fixtures';
import { BatonView } from '../../../../../renderer/components/PlaygroundPanel/components';
import { makeBatonState } from '../_fixtures';
import { ConfettiView } from '../../../../../renderer/components/PlaygroundPanel/components';
import { makeConfettiState } from '../_fixtures';
describeSourceSuite('PlaygroundHeaderTabs', () => {
	describe('PlaygroundPanel header and tabs', () => {
		it('renders the header title and close button', () => {
			const onClose = vi.fn();
			render(<PlaygroundHeader theme={mockTheme} onClose={onClose} />);

			expect(screen.getByText('Developer Playground')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('renders all tabs and calls selection callback', () => {
			const onSelectTab = vi.fn();
			render(
				<PlaygroundTabs theme={mockTheme} activeTab="achievements" onSelectTab={onSelectTab} />
			);

			expect(screen.getByText('Achievements')).toBeInTheDocument();
			expect(screen.getByText('Confetti')).toBeInTheDocument();
			expect(screen.getByText('Baton')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Baton/ }));
			expect(onSelectTab).toHaveBeenCalledWith('baton');
		});

		it('applies active tab styling from the theme', () => {
			render(<PlaygroundTabs theme={mockTheme} activeTab="confetti" onSelectTab={vi.fn()} />);

			expect(screen.getByRole('button', { name: /Confetti/ })).toHaveStyle({
				color: mockTheme.colors.accent,
				borderColor: mockTheme.colors.accent,
				backgroundColor: 'rgba(189, 147, 249, 0.1)',
			});
		});
	});
});
describeSourceSuite('BatonView', () => {
	describe('BatonView', () => {
		it('renders all preview regions', () => {
			render(<BatonView theme={mockTheme} baton={makeBatonState()} />);

			expect(screen.getByText('Large Preview (4x)')).toBeInTheDocument();
			expect(screen.getByText('Real Size Preview')).toBeInTheDocument();
			expect(screen.getByText('Expanded:')).toBeInTheDocument();
			expect(screen.getByText('Collapsed:')).toBeInTheDocument();
			expect(screen.getByText('Sizes:')).toBeInTheDocument();
			expect(screen.getAllByText('MAESTRO').length).toBeGreaterThanOrEqual(1);
		});

		it('renders active and paused animation states', () => {
			const { rerender } = render(<BatonView theme={mockTheme} baton={makeBatonState()} />);

			expect(screen.getByText('Animation active')).toBeInTheDocument();

			rerender(<BatonView theme={mockTheme} baton={makeBatonState({ batonActive: false })} />);
			expect(screen.getByText('Animation paused')).toBeInTheDocument();
		});

		it('wires animation toggle and reset', () => {
			const baton = makeBatonState();
			render(<BatonView theme={mockTheme} baton={baton} />);

			fireEvent.click(screen.getByRole('button', { name: 'Active' }));
			fireEvent.click(screen.getByRole('button', { name: /Reset to Defaults/ }));

			expect(baton.toggleBatonActive).toHaveBeenCalledTimes(1);
			expect(baton.resetBatonDefaults).toHaveBeenCalledTimes(1);
		});

		it('wires timing and movement sliders', () => {
			const baton = makeBatonState();
			render(<BatonView theme={mockTheme} baton={baton} />);

			const sliders = screen.getAllByRole('slider');
			fireEvent.change(sliders[0], { target: { value: '5' } });
			fireEvent.change(sliders[1], { target: { value: '20' } });
			fireEvent.change(sliders[2], { target: { value: '80' } });
			fireEvent.change(sliders[3], { target: { value: '1.25' } });
			fireEvent.change(sliders[4], { target: { value: '2' } });

			expect(baton.setDuration).toHaveBeenCalledWith(5);
			expect(baton.setPeakAt).toHaveBeenCalledWith(20);
			expect(baton.setSettleAt).toHaveBeenCalledWith(80);
			expect(baton.setStaggerOffset).toHaveBeenCalledWith(1.25);
			expect(baton.setTranslateAmount).toHaveBeenCalledWith(2);
		});

		it('wires easing buttons and copy action', () => {
			const baton = makeBatonState();
			render(<BatonView theme={mockTheme} baton={baton} />);

			fireEvent.click(screen.getByRole('button', { name: 'linear' }));
			fireEvent.click(screen.getByRole('button', { name: /Copy CSS Settings/ }));

			expect(baton.setEasing).toHaveBeenCalledWith('linear');
			expect(baton.copyBatonSettings).toHaveBeenCalledTimes(1);
		});

		it('renders copied CSS state', () => {
			render(<BatonView theme={mockTheme} baton={makeBatonState({ batonCopySuccess: true })} />);

			expect(screen.getByRole('button', { name: /Copied CSS!/ })).toBeInTheDocument();
		});
	});
});
describeSourceSuite('ConfettiView', () => {
	describe('ConfettiView', () => {
		it('renders origin grid, controls, and actions', () => {
			render(<ConfettiView theme={mockTheme} confetti={makeConfettiState()} />);

			expect(screen.getByText('Launch Origins (click to toggle)')).toBeInTheDocument();
			expect(screen.getByText('Basic Parameters')).toBeInTheDocument();
			expect(screen.getByText('Physics')).toBeInTheDocument();
			expect(screen.getByText('Colors')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Fire Confetti!/ })).toBeInTheDocument();
		});

		it('wires origin and shape toggles', () => {
			const confetti = makeConfettiState();
			render(<ConfettiView theme={mockTheme} confetti={confetti} />);

			fireEvent.click(screen.getByTitle('Top Left'));
			fireEvent.click(screen.getByRole('button', { name: /★ star/ }));

			expect(confetti.toggleOrigin).toHaveBeenCalledWith(0, 0);
			expect(confetti.toggleShape).toHaveBeenCalledWith('star');
		});

		it('disables the fire button when no origins are selected', () => {
			render(
				<ConfettiView
					theme={mockTheme}
					confetti={makeConfettiState({ selectedOrigins: new Set() })}
				/>
			);

			expect(screen.getByRole('button', { name: /Fire Confetti!/ })).toBeDisabled();
			expect(screen.getByText('Select at least one origin')).toBeInTheDocument();
		});

		it('wires parameter sliders and flat checkbox', () => {
			const confetti = makeConfettiState();
			render(<ConfettiView theme={mockTheme} confetti={confetti} />);

			const sliders = screen.getAllByRole('slider');
			fireEvent.change(sliders[0], { target: { value: '250' } });
			fireEvent.change(sliders[1], { target: { value: '180' } });
			fireEvent.change(sliders[4], { target: { value: '1.8' } });
			fireEvent.click(screen.getByLabelText('Flat (disable 3D wobble)'));

			expect(confetti.setParticleCount).toHaveBeenCalledWith(250);
			expect(confetti.setAngle).toHaveBeenCalledWith(180);
			expect(confetti.setGravity).toHaveBeenCalledWith(1.8);
			expect(confetti.setFlat).toHaveBeenCalledWith(true);
		});

		it('wires color editing, add, and remove buttons', () => {
			const confetti = makeConfettiState();
			render(<ConfettiView theme={mockTheme} confetti={confetti} />);

			const firstColorInput = document.querySelector('input[type="color"]') as HTMLInputElement;
			fireEvent.change(firstColorInput, { target: { value: '#00ff00' } });
			fireEvent.click(screen.getByRole('button', { name: '+' }));
			fireEvent.click(screen.getAllByRole('button', { name: /Remove color/ })[0]);

			expect(confetti.setColorAt).toHaveBeenCalledWith(0, '#00ff00');
			expect(confetti.addColor).toHaveBeenCalledTimes(1);
			expect(confetti.removeColor).toHaveBeenCalledWith(0);
		});

		it('wires fire, copy, and reset actions', () => {
			const confetti = makeConfettiState();
			render(<ConfettiView theme={mockTheme} confetti={confetti} />);

			fireEvent.click(screen.getByRole('button', { name: /Fire Confetti!/ }));
			fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			fireEvent.click(screen.getByRole('button', { name: /Reset to Defaults/ }));

			expect(confetti.firePlaygroundConfetti).toHaveBeenCalledTimes(1);
			expect(confetti.copyConfettiSettings).toHaveBeenCalledTimes(1);
			expect(confetti.resetConfettiSettings).toHaveBeenCalledTimes(1);
		});

		it('renders copied state', () => {
			render(
				<ConfettiView theme={mockTheme} confetti={makeConfettiState({ copySuccess: true })} />
			);

			expect(screen.getByRole('button', { name: /Copied!/ })).toBeInTheDocument();
		});
	});
});
