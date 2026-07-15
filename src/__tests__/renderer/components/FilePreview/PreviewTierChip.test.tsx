import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviewTierChip } from '../../../../renderer/components/FilePreview/PreviewTierChip';
import { mockTheme } from '../../../helpers/mockTheme';

describe('PreviewTierChip', () => {
	function renderChip(
		opts: {
			autoTier?: 'rich' | 'fast' | 'giant';
			override?: 'rich' | 'fast' | 'giant';
			visible?: boolean;
			onSelect?: (tier: 'rich' | 'fast' | 'giant' | undefined) => void;
		} = {}
	) {
		const onSelect = opts.onSelect ?? vi.fn();
		const utils = render(
			<PreviewTierChip
				theme={mockTheme}
				autoTier={opts.autoTier ?? 'fast'}
				override={opts.override}
				onSelect={onSelect}
				visible={opts.visible}
			/>
		);
		return { ...utils, onSelect };
	}

	describe('rendering', () => {
		it('renders the auto tier label when no override is set', () => {
			renderChip({ autoTier: 'fast' });
			const btn = screen.getByTestId('preview-tier-chip-button');
			expect(btn.textContent).toContain('Fast');
			expect(btn.textContent).toContain('auto');
		});

		it('renders the override tier label when an override is set', () => {
			renderChip({ autoTier: 'fast', override: 'rich' });
			const btn = screen.getByTestId('preview-tier-chip-button');
			expect(btn.textContent).toContain('Rich');
			expect(btn.textContent).not.toContain('auto');
		});

		it('shows "Giant" when giant is the effective tier', () => {
			renderChip({ autoTier: 'giant' });
			expect(screen.getByTestId('preview-tier-chip-button').textContent).toContain('Giant');
		});

		it('does not render when visible is false', () => {
			renderChip({ visible: false });
			expect(screen.queryByTestId('preview-tier-chip')).toBeNull();
		});

		it('renders when visible is omitted (default true)', () => {
			renderChip({});
			expect(screen.getByTestId('preview-tier-chip')).toBeTruthy();
		});

		it('marks button with aria-expanded false by default', () => {
			renderChip({});
			const btn = screen.getByTestId('preview-tier-chip-button');
			expect(btn.getAttribute('aria-expanded')).toBe('false');
		});

		it('tooltip says "Auto" when no override is set', () => {
			renderChip({ autoTier: 'fast' });
			expect(screen.getByTestId('preview-tier-chip-button').getAttribute('title')).toContain(
				'Auto'
			);
		});

		it('tooltip says "Forced" when an override is set', () => {
			renderChip({ autoTier: 'fast', override: 'rich' });
			expect(screen.getByTestId('preview-tier-chip-button').getAttribute('title')).toContain(
				'Forced'
			);
		});
	});

	describe('menu interaction', () => {
		it('opens the menu when the chip is clicked', () => {
			renderChip({});
			expect(screen.queryByTestId('preview-tier-chip-menu')).toBeNull();
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			expect(screen.getByTestId('preview-tier-chip-menu')).toBeTruthy();
		});

		it('shows all four menu rows: Auto, Rich, Fast, Giant', () => {
			renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const menu = screen.getByTestId('preview-tier-chip-menu');
			expect(menu.textContent).toContain('Auto');
			expect(menu.textContent).toContain('Rich');
			expect(menu.textContent).toContain('Fast');
			expect(menu.textContent).toContain('Giant');
		});

		describe('status header', () => {
			it('shows "Currently rendering: <autoTier>" when no override is set', () => {
				renderChip({ autoTier: 'fast' });
				fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
				const status = screen.getByTestId('preview-tier-chip-status');
				expect(status.textContent).toContain('Currently rendering');
				expect(status.textContent).toContain('Fast');
			});

			it('shows the OVERRIDE tier (not autoTier) when an override is set', () => {
				renderChip({ autoTier: 'fast', override: 'rich' });
				fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
				const status = screen.getByTestId('preview-tier-chip-status');
				expect(status.textContent).toContain('Rich');
				expect(status.textContent).not.toContain('Fast');
			});

			it('shows "Giant" when override is giant', () => {
				renderChip({ autoTier: 'fast', override: 'giant' });
				fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
				expect(screen.getByTestId('preview-tier-chip-status').textContent).toContain('Giant');
			});
		});

		describe('Auto row description', () => {
			it('describes what Auto picks, not the current render', () => {
				renderChip({ autoTier: 'fast' });
				fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
				const autoRow = screen.getAllByRole('menuitem')[0];
				expect(autoRow.textContent).toContain('Auto picks Fast');
			});

			it('still describes Auto correctly when an override is active', () => {
				// Override is Rich; Auto would still pick Fast - the row text
				// must reflect Auto behavior, not the override.
				renderChip({ autoTier: 'fast', override: 'rich' });
				fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
				const autoRow = screen.getAllByRole('menuitem')[0];
				expect(autoRow.textContent).toContain('Auto picks Fast');
			});
		});

		it('closes the menu after a selection', () => {
			const { onSelect } = renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const rows = screen.getAllByRole('menuitem');
			fireEvent.click(rows[1]); // Rich
			expect(onSelect).toHaveBeenCalledWith('rich');
			expect(screen.queryByTestId('preview-tier-chip-menu')).toBeNull();
		});

		it('toggles the menu off when the chip is clicked while open', () => {
			renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			expect(screen.getByTestId('preview-tier-chip-menu')).toBeTruthy();
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			expect(screen.queryByTestId('preview-tier-chip-menu')).toBeNull();
		});

		it('closes when Escape is pressed', () => {
			renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			expect(screen.getByTestId('preview-tier-chip-menu')).toBeTruthy();
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(screen.queryByTestId('preview-tier-chip-menu')).toBeNull();
		});

		it('closes when clicking outside', () => {
			renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			expect(screen.getByTestId('preview-tier-chip-menu')).toBeTruthy();
			fireEvent.mouseDown(document.body);
			expect(screen.queryByTestId('preview-tier-chip-menu')).toBeNull();
		});
	});

	describe('selection actions', () => {
		it('Auto row calls onSelect(undefined) to clear the override', () => {
			const { onSelect } = renderChip({ override: 'rich' });
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const autoRow = screen.getAllByRole('menuitem')[0];
			fireEvent.click(autoRow);
			expect(onSelect).toHaveBeenCalledWith(undefined);
		});

		it('Rich row calls onSelect("rich")', () => {
			const { onSelect } = renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const rows = screen.getAllByRole('menuitem');
			fireEvent.click(rows[1]);
			expect(onSelect).toHaveBeenCalledWith('rich');
		});

		it('Fast row calls onSelect("fast")', () => {
			const { onSelect } = renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const rows = screen.getAllByRole('menuitem');
			fireEvent.click(rows[2]);
			expect(onSelect).toHaveBeenCalledWith('fast');
		});

		it('Giant row calls onSelect("giant")', () => {
			const { onSelect } = renderChip({});
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const rows = screen.getAllByRole('menuitem');
			fireEvent.click(rows[3]);
			expect(onSelect).toHaveBeenCalledWith('giant');
		});

		it('marks the active row with aria-current', () => {
			renderChip({ override: 'fast' });
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const rows = screen.getAllByRole('menuitem');
			// Rows: [Auto, Rich, Fast, Giant]. Fast is the active override.
			expect(rows[2].getAttribute('aria-current')).toBe('true');
			expect(rows[0].getAttribute('aria-current')).toBeNull();
			expect(rows[1].getAttribute('aria-current')).toBeNull();
			expect(rows[3].getAttribute('aria-current')).toBeNull();
		});

		it('marks Auto as active when no override is set', () => {
			renderChip({ override: undefined });
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			const rows = screen.getAllByRole('menuitem');
			expect(rows[0].getAttribute('aria-current')).toBe('true');
			expect(rows[1].getAttribute('aria-current')).toBeNull();
			expect(rows[2].getAttribute('aria-current')).toBeNull();
			expect(rows[3].getAttribute('aria-current')).toBeNull();
		});
	});

	describe('iconOnly mode', () => {
		it('renders an icon-only trigger without the label or "auto" text', () => {
			render(
				<PreviewTierChip
					theme={mockTheme}
					autoTier="fast"
					override={undefined}
					onSelect={vi.fn()}
					iconOnly
					headerBtnClass="header-btn"
					headerIconClass="header-icon"
				/>
			);
			const btn = screen.getByTestId('preview-tier-chip-button');
			expect(btn.textContent).not.toContain('Fast');
			expect(btn.textContent).not.toContain('auto');
			expect(btn.className).toBe('header-btn');
		});

		it('opens the same popover menu in iconOnly mode', () => {
			render(
				<PreviewTierChip
					theme={mockTheme}
					autoTier="fast"
					override={undefined}
					onSelect={vi.fn()}
					iconOnly
					headerBtnClass="header-btn"
					headerIconClass="header-icon"
				/>
			);
			fireEvent.click(screen.getByTestId('preview-tier-chip-button'));
			expect(screen.getByTestId('preview-tier-chip-menu')).toBeTruthy();
		});

		it('preserves the same tooltip wording as the labeled chip', () => {
			render(
				<PreviewTierChip
					theme={mockTheme}
					autoTier="fast"
					override="rich"
					onSelect={vi.fn()}
					iconOnly
					headerBtnClass="header-btn"
					headerIconClass="header-icon"
				/>
			);
			// iconOnly mode renders the tooltip via <HoverTooltip>, which mounts
			// its content into a portal only after mouseenter - so hover the
			// wrapper, then assert the portaled tooltip text.
			const btn = screen.getByTestId('preview-tier-chip-button');
			fireEvent.mouseEnter(btn.parentElement as HTMLElement);
			const tip = screen.getByRole('tooltip');
			expect(tip.textContent).toContain('Forced');
		});
	});
});
