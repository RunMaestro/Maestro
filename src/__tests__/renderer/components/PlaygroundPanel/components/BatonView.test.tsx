import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BatonView } from '../../../../../renderer/components/PlaygroundPanel/components';
import { makeBatonState, mockTheme } from '../_fixtures';

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
		expect(baton.setFadeOutStart).toHaveBeenCalledWith(20);
		expect(baton.setFadeInStart).toHaveBeenCalledWith(80);
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
