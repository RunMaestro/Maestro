import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfettiView } from '../../../../../renderer/components/PlaygroundPanel/components';
import { makeConfettiState, mockTheme } from '../_fixtures';

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
		render(<ConfettiView theme={mockTheme} confetti={makeConfettiState({ copySuccess: true })} />);

		expect(screen.getByRole('button', { name: /Copied!/ })).toBeInTheDocument();
	});
});
