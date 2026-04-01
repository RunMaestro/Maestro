import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemedSelect as CueSelect } from '../../../../../renderer/components/shared/ThemedSelect';
import type { Theme } from '../../../../../renderer/types';

vi.mock('../../../../../renderer/hooks/ui', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../../../../../renderer/hooks/ui');
	return { ...actual, useClickOutside: vi.fn() };
});

const theme = {
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#222',
		bgActivity: '#333',
		border: '#444',
		textMain: '#fff',
		textDim: '#999',
		accent: '#06b6d4',
	},
} as Theme;

const options = [
	{ value: 'a', label: 'Alpha' },
	{ value: 'b', label: 'Beta' },
	{ value: 'c', label: 'Gamma' },
];

describe('CueSelect', () => {
	let onChange: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onChange = vi.fn();
	});

	it('renders the selected option label', () => {
		render(<CueSelect value="b" options={options} onChange={onChange} theme={theme} />);
		expect(screen.getByText('Beta')).toBeTruthy();
	});

	it('opens dropdown on click and shows all options', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		const trigger = screen.getByText('Alpha').closest('button')!;
		fireEvent.click(trigger);
		// All three options visible (Alpha appears twice: trigger + dropdown)
		expect(screen.getAllByText('Alpha')).toHaveLength(2);
		expect(screen.getByText('Beta')).toBeTruthy();
		expect(screen.getByText('Gamma')).toBeTruthy();
	});

	it('calls onChange and closes on option select', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
		fireEvent.click(screen.getByText('Gamma'));
		expect(onChange).toHaveBeenCalledWith('c');
		// Dropdown should close — only the trigger button visible
		expect(screen.queryAllByText('Beta')).toHaveLength(0);
	});

	it('closes on Escape key', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		const trigger = screen.getByText('Alpha').closest('button')!;
		fireEvent.click(trigger);
		expect(screen.getByText('Gamma')).toBeTruthy();
		// The component listens on document with capture phase
		act(() => {
			const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
			document.dispatchEvent(event);
		});
		expect(screen.queryAllByText('Gamma')).toHaveLength(0);
	});

	it('highlights the selected option with fontWeight 500', () => {
		render(<CueSelect value="b" options={options} onChange={onChange} theme={theme} />);
		// Open the dropdown
		const trigger = screen.getByText('Beta').closest('button')!;
		fireEvent.click(trigger);
		// Find the dropdown option button (not the trigger)
		const allButtons = screen.getAllByRole('button');
		const betaOption = allButtons.find((btn) => btn.textContent === 'Beta' && btn !== trigger);
		expect(betaOption).toBeTruthy();
		expect(betaOption!.style.fontWeight).toBe('500');
	});

	it('falls back to raw value when no option matches', () => {
		render(<CueSelect value="unknown" options={options} onChange={onChange} theme={theme} />);
		expect(screen.getByText('unknown')).toBeTruthy();
	});
});
