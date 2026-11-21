import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { ModalResizeGrip } from '../../../../renderer/components/ui/ModalResizeGrip';
import { mockTheme } from '../../../helpers/mockTheme';
import { Spinner } from '../../../../renderer/components/ui/Spinner';
import { SortableTh } from '../../../../renderer/components/ui/SortableTh';
import type { Theme } from '../../../../renderer/types';
import { StartTruncatedText } from '../../../../renderer/components/ui/StartTruncatedText';
import { CollapsedCommandsNotice } from '../../../../renderer/components/ui/CollapsedCommandsNotice';
import { Folder } from 'lucide-react';
import type { IconPackContribution } from '../../../../shared/plugins/contributions';
import { resolveGroupAppearance } from '../../../../renderer/components/ui/groupAppearanceOptions';
import { MiniBadge } from '../../../../renderer/components/ui/MiniBadge';
__maestroMicrobenchDescribe('ModalResizeGrip', () => {
	describe('ModalResizeGrip', () => {
		it('starts a mouse-driven resize on mousedown', () => {
			const onResizeStart = vi.fn();
			render(
				<ModalResizeGrip
					theme={mockTheme}
					onResizeStart={onResizeStart}
					onReset={vi.fn()}
					canReset
				/>
			);

			fireEvent.mouseDown(screen.getByTestId('modal-resize-grip'));
			expect(onResizeStart).toHaveBeenCalledTimes(1);
		});

		it('starts a pointer-driven resize on pointerdown, and ignores mousedown then', () => {
			const onResizeStart = vi.fn();
			const onResizePointerDown = vi.fn();
			render(
				<ModalResizeGrip
					theme={mockTheme}
					onResizeStart={onResizeStart}
					onResizePointerDown={onResizePointerDown}
					onReset={vi.fn()}
					canReset={false}
					label="Resize gauge"
				/>
			);

			const grip = screen.getByRole('separator', { name: 'Resize gauge' });
			fireEvent.pointerDown(grip);
			fireEvent.mouseDown(grip);
			expect(onResizePointerDown).toHaveBeenCalledTimes(1);
			expect(onResizeStart).not.toHaveBeenCalled();
			expect(grip).toHaveAttribute('title', 'Drag to resize');
		});

		it('resets on double-click', () => {
			const onReset = vi.fn();
			render(<ModalResizeGrip onResizePointerDown={vi.fn()} onReset={onReset} canReset />);

			fireEvent.doubleClick(screen.getByTestId('modal-resize-grip'));
			expect(onReset).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId('modal-resize-grip')).toHaveAttribute(
				'title',
				'Drag to resize, double-click to reset'
			);
		});
	});
});
__maestroMicrobenchDescribe('Spinner', () => {
	describe('Spinner', () => {
		it('renders with default size', () => {
			render(<Spinner />);
			const icon = screen.getByRole('status');
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveClass('animate-spin');
			expect(icon).toHaveStyle({ width: '16px', height: '16px' });
		});

		it('applies custom size', () => {
			render(<Spinner size={32} />);
			const icon = screen.getByRole('status');
			expect(icon).toHaveStyle({ width: '32px', height: '32px' });
		});

		it('applies custom color', () => {
			render(<Spinner color="rgb(255, 0, 0)" />);
			const icon = screen.getByRole('status');
			expect(icon).toHaveStyle({ color: 'rgb(255, 0, 0)' });
		});

		it('merges custom className', () => {
			render(<Spinner className="text-blue-500" />);
			const icon = screen.getByRole('status');
			expect(icon).toHaveClass('animate-spin');
			expect(icon).toHaveClass('text-blue-500');
		});

		// Chromium runs a transform animation on an <svg> on the main thread every
		// frame; on a wrapping element it runs on the compositor.
		it('spins a wrapper, never the svg itself', () => {
			render(<Spinner />);
			expect(screen.getByRole('status')).toHaveClass('animate-spin');
			expect(screen.getByTestId('loader2-icon')).not.toHaveClass('animate-spin');
		});
	});
});
__maestroMicrobenchDescribe('SortableTh', () => {
	const theme = {
		colors: { textDim: '#888', textMain: '#fff', accent: '#06b6d4', border: '#333' },
	} as unknown as Theme;

	function renderHeader(props: Partial<React.ComponentProps<typeof SortableTh>> = {}) {
		const onSort = vi.fn();
		render(
			<table>
				<thead>
					<tr>
						<SortableTh
							columnKey="next"
							label="Next"
							sortKey="next"
							direction="asc"
							onSort={onSort}
							theme={theme}
							testId="th-next"
							{...props}
						/>
					</tr>
				</thead>
			</table>
		);
		return { onSort };
	}

	describe('SortableTh', () => {
		it('puts aria-sort on the th, reflecting the active direction', () => {
			renderHeader();
			expect(screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'ascending');
		});

		it('reports descending when the active column is reversed', () => {
			renderHeader({ direction: 'desc' });
			expect(screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'descending');
		});

		it('reports none when another column is the active one', () => {
			renderHeader({ sortKey: 'agent' });
			expect(screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'none');
		});

		it('is a real button, so it is keyboard reachable and activatable', () => {
			// A `<th role="button" onClick>` announces as a button but has no tab
			// stop and no Enter/Space handling - it is unusable by keyboard.
			const { onSort } = renderHeader();
			const button = screen.getByRole('button', { name: 'Next' });

			button.focus();
			expect(button).toHaveFocus();

			fireEvent.click(button);
			expect(onSort).toHaveBeenCalledWith('next');
		});

		it('always lays out the caret so switching columns does not reflow the row', () => {
			renderHeader({ sortKey: 'agent' });
			const caret = screen.getByTestId('th-next').querySelector('svg');

			// Present in the DOM (space reserved) but invisible on an inactive column.
			expect(caret).not.toBeNull();
			expect(caret).toHaveStyle({ opacity: '0' });
		});
	});
});
__maestroMicrobenchDescribe('StartTruncatedText', () => {
	describe('StartTruncatedText', () => {
		it('clips on one line with the ellipsis at the start', () => {
			render(<StartTruncatedText testId="path">src/a/b/file.tsx</StartTruncatedText>);
			const el = screen.getByTestId('path');
			expect(el).toHaveClass('min-w-0', 'overflow-hidden', 'text-ellipsis', 'whitespace-nowrap');
			expect(el).toHaveStyle({ direction: 'rtl', textAlign: 'left' });
		});

		it('isolates the text in a <bdi> so punctuation stays put', () => {
			render(<StartTruncatedText testId="path">file (1).tsx</StartTruncatedText>);
			const text = screen.getByText('file (1).tsx');
			expect(text.tagName).toBe('BDI');
			expect(text.parentElement).toBe(screen.getByTestId('path'));
		});

		it('defaults the tooltip to string children', () => {
			render(<StartTruncatedText testId="path">src/a/b/file.tsx</StartTruncatedText>);
			expect(screen.getByTestId('path')).toHaveAttribute('title', 'src/a/b/file.tsx');
		});

		it('uses an explicit title, and null suppresses it', () => {
			const { rerender } = render(
				<StartTruncatedText testId="path" title="full name">
					name
				</StartTruncatedText>
			);
			expect(screen.getByTestId('path')).toHaveAttribute('title', 'full name');
			rerender(
				<StartTruncatedText testId="path" title={null}>
					name
				</StartTruncatedText>
			);
			expect(screen.getByTestId('path')).not.toHaveAttribute('title');
		});

		it('merges caller classes and styles', () => {
			render(
				<StartTruncatedText testId="path" className="font-mono" style={{ color: 'red' }}>
					x
				</StartTruncatedText>
			);
			const el = screen.getByTestId('path');
			expect(el).toHaveClass('font-mono', 'overflow-hidden');
			expect(el).toHaveStyle({ color: 'rgb(255, 0, 0)', direction: 'rtl' });
		});
	});
});
__maestroMicrobenchDescribe('CollapsedCommandsNotice', () => {
	describe('CollapsedCommandsNotice', () => {
		it('pluralizes the hidden-command count and offers to reveal', () => {
			render(
				<CollapsedCommandsNotice
					theme={mockTheme}
					count={3}
					expanded={false}
					onToggle={vi.fn()}
					sectionName="Spec Kit"
				/>
			);
			expect(screen.getByText('3 Spec Kit commands hidden')).toBeInTheDocument();
			expect(screen.getByText('Show anyway')).toBeInTheDocument();
		});

		it('uses the singular noun for a single command', () => {
			render(
				<CollapsedCommandsNotice
					theme={mockTheme}
					count={1}
					expanded={false}
					onToggle={vi.fn()}
					sectionName="BMAD"
				/>
			);
			expect(screen.getByText('1 BMAD command hidden')).toBeInTheDocument();
		});

		it('shows the collapse affordance and aria-expanded when expanded', () => {
			render(
				<CollapsedCommandsNotice
					theme={mockTheme}
					count={2}
					expanded={true}
					onToggle={vi.fn()}
					sectionName="OpenSpec"
				/>
			);
			expect(screen.getByText('Collapse')).toBeInTheDocument();
			expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
		});

		it('fires onToggle when clicked', () => {
			const onToggle = vi.fn();
			render(
				<CollapsedCommandsNotice
					theme={mockTheme}
					count={2}
					expanded={false}
					onToggle={onToggle}
					sectionName="Spec Kit"
				/>
			);
			fireEvent.click(screen.getByRole('button'));
			expect(onToggle).toHaveBeenCalledTimes(1);
		});
	});
});
__maestroMicrobenchDescribe('groupAppearanceOptions', () => {
	const iconPacks: IconPackContribution[] = [
		{
			id: 'com.acme/bright',
			localId: 'bright',
			pluginId: 'com.acme',
			label: 'Acme Bright',
			icons: [
				{
					id: 'com.acme/bright/bolt',
					localId: 'bolt',
					label: 'Bolt',
					path: 'M13 2L3 14H12L11 22L21 10H12L13 2',
				},
			],
			colors: [
				{
					id: 'com.acme/bright/lime',
					localId: 'lime',
					label: 'Lime',
					value: '#22C55E',
				},
			],
		},
	];

	describe('resolveGroupAppearance', () => {
		it('resolves contributed icon paths and color values', () => {
			const appearance = resolveGroupAppearance(
				'com.acme/bright/bolt',
				'com.acme/bright/lime',
				iconPacks
			);

			expect(appearance).toMatchObject({
				icon: {
					kind: 'plugin',
					path: 'M13 2L3 14H12L11 22L21 10H12L13 2',
				},
				color: '#22C55E',
			});
		});

		it('falls back without mutating stored plugin ids when the pack is unavailable', () => {
			const group = {
				icon: 'com.acme/bright/bolt',
				color: 'com.acme/bright/lime',
			};

			const appearance = resolveGroupAppearance(group.icon, group.color, []);

			expect(appearance.icon).toEqual({ kind: 'missing', Icon: Folder });
			expect(appearance.color).toBeUndefined();
			expect(group).toEqual({
				icon: 'com.acme/bright/bolt',
				color: 'com.acme/bright/lime',
			});
		});
	});
});
__maestroMicrobenchDescribe('MiniBadge', () => {
	function renderBadge(props: Partial<React.ComponentProps<typeof MiniBadge>> = {}) {
		const { container } = render(<MiniBadge label="Snoozed" theme={mockTheme} {...props} />);
		return container.firstElementChild as HTMLElement;
	}

	describe('MiniBadge', () => {
		it('renders the label verbatim, leaving the uppercasing to CSS', () => {
			// A screen reader reads the DOM text, not the rendered casing, so the
			// string must stay as the caller wrote it.
			expect(renderBadge().textContent).toBe('Snoozed');
			expect(renderBadge().className).toContain('uppercase');
		});

		it('tints text and fill from one color, defaulting to the theme accent', () => {
			expect(renderBadge().style.color).toBeTruthy();
			const warned = renderBadge({ color: '#ff0000' });
			expect(warned.style.color).toBe('rgb(255, 0, 0)');
			expect(warned.style.backgroundColor).toBe('rgba(255, 0, 0, 0.125)');
		});

		it('carries an optional tooltip and test id', () => {
			const badge = renderBadge({ title: 'Worktree agent', testId: 'wt-badge' });
			expect(badge.getAttribute('title')).toBe('Worktree agent');
			expect(badge.getAttribute('data-testid')).toBe('wt-badge');
		});
	});
});
