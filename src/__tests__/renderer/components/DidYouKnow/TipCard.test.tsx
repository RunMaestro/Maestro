import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DID_YOU_KNOW_TIPS } from '../../../../shared/didYouKnow';
import { TipCard } from '../../../../renderer/components/DidYouKnow/TipCard';
import { FIXED_SHORTCUTS } from '../../../../renderer/constants/shortcuts';
import { safeClipboardWrite } from '../../../../renderer/utils/clipboard';
import { resolveFixedPitchFontFamily } from '../../../../renderer/utils/fixedPitchFont';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../../renderer/utils/fixedPitchFont', () => ({
	resolveFixedPitchFontFamily: vi.fn().mockReturnValue('monospace'),
}));

const tip = DID_YOU_KNOW_TIPS[0];

describe('TipCard', () => {
	it('renders selectable copy in order with separate body paragraphs', () => {
		const { container } = render(<TipCard tip={tip} theme={mockTheme} />);
		expect(container.firstChild).toHaveClass('select-text');
		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(tip.title);
		expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
			tip.headline,
			...tip.body,
		]);
		expect(screen.getByText(tip.body[0]).parentElement).toHaveStyle({
			color: mockTheme.colors.textDim,
		});
		expect(container.querySelector('kbd')).toBeNull();
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('shows Encore only for a disabled feature and updates when enabled', () => {
		const { rerender } = render(
			<TipCard tip={tip} theme={mockTheme} encoreFeatures={{ maestroCue: false }} />
		);
		expect(screen.getByText('Encore')).toBeInTheDocument();
		rerender(<TipCard tip={tip} theme={mockTheme} encoreFeatures={{ maestroCue: true }} />);
		expect(screen.queryByText('Encore')).toBeNull();
		rerender(<TipCard tip={{ ...tip, encore: undefined }} theme={mockTheme} />);
		expect(screen.queryByText('Encore')).toBeNull();
	});

	it('uses canonical defaults when a feature has no persisted value', () => {
		const { rerender } = render(<TipCard tip={tip} theme={mockTheme} />);
		expect(screen.queryByText('Encore')).toBeNull();
		rerender(<TipCard tip={{ ...tip, encore: 'concerto' }} theme={mockTheme} />);
		expect(screen.getByText('Encore')).toBeInTheDocument();
	});

	it.each(['shortcuts', 'tabShortcuts'] as const)(
		'displays live %s and removes unbound keys',
		(map) => {
			const binding = { id: tip.shortcutId!, label: tip.title, keys: ['Meta', 'Shift', 'j'] };
			const { container, rerender } = render(
				<TipCard tip={tip} theme={mockTheme} {...{ [map]: { [binding.id]: binding } }} />
			);
			expect(container.querySelector('kbd')).toHaveTextContent(formatShortcutKeys(binding.keys));
			expect(container.querySelector('kbd')).toHaveAttribute('data-shortcut-hint');
			binding.keys = ['Alt', 'k'];
			rerender(<TipCard tip={tip} theme={mockTheme} {...{ [map]: { [binding.id]: binding } }} />);
			expect(container.querySelector('kbd')).toHaveTextContent(formatShortcutKeys(binding.keys));
			binding.keys = [];
			rerender(<TipCard tip={tip} theme={mockTheme} {...{ [map]: { [binding.id]: binding } }} />);
			expect(container.querySelector('kbd')).toBeNull();
		}
	);

	it('supports fixed shortcuts while respecting an explicitly cleared binding', () => {
		const fixed = Object.values(FIXED_SHORTCUTS).find((shortcut) => shortcut.keys.length)!;
		const fixedTip = { ...tip, shortcutId: fixed.id };
		const { container, rerender } = render(<TipCard tip={fixedTip} theme={mockTheme} />);
		expect(container.querySelector('kbd')).toHaveTextContent(formatShortcutKeys(fixed.keys));
		rerender(
			<TipCard
				tip={fixedTip}
				theme={mockTheme}
				shortcuts={{ [fixed.id]: { ...fixed, keys: [] } }}
			/>
		);
		expect(container.querySelector('kbd')).toBeNull();
	});

	it('copies the current CLI command and resolves its fixed-pitch font', async () => {
		const cliTip = DID_YOU_KNOW_TIPS[1];
		const { rerender } = render(<TipCard tip={cliTip} theme={mockTheme} fontFamily="Avenir" />);
		expect(resolveFixedPitchFontFamily).toHaveBeenCalledWith('Avenir');
		expect(screen.getByText(cliTip.cli!)).toHaveStyle({ fontFamily: 'monospace' });
		fireEvent.click(screen.getByRole('button', { name: 'Copy CLI command' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith(cliTip.cli));
		rerender(<TipCard tip={{ ...cliTip, cli: 'maestro-cli cue list' }} theme={mockTheme} />);
		fireEvent.click(screen.getByRole('button', { name: 'Copy CLI command' }));
		await waitFor(() =>
			expect(safeClipboardWrite).toHaveBeenLastCalledWith('maestro-cli cue list')
		);
	});
});
