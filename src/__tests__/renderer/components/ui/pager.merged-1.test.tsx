// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/ui/Pager.test.tsx
// Source: src/__tests__/renderer/components/ui/TextareaLineNumbers.test.tsx
// Source: src/__tests__/renderer/components/ui/GhostIconButton.test.tsx
// Source: src/__tests__/renderer/components/ui/TextareaHighlightOverlay.test.tsx
// Source: src/__tests__/renderer/components/ui/ToggleSwitch.test.tsx
// Source: src/__tests__/renderer/components/ui/HeaderActionButton.test.tsx
// Source: src/__tests__/renderer/components/ui/ProviderAvailabilityBar.test.tsx
// Source: src/__tests__/renderer/components/ui/ShortcutHint.test.tsx
// Source: src/__tests__/renderer/components/ui/HoverTooltip.test.tsx
// Source: src/__tests__/renderer/components/ui/EmptyStatePlaceholder.test.tsx
// Source: src/__tests__/renderer/components/ui/CountBadge.test.tsx
// Source: src/__tests__/renderer/components/ui/CornerDot.test.tsx
// Source: src/__tests__/renderer/components/ui/SafeSvgIcon.test.tsx
import { describe, it, expect, vi } from 'vitest';
import {
	render as s1_render,
	screen as s1_screen,
	fireEvent as s1_fireEvent,
} from '@testing-library/react';
import { Pager } from '../../../../renderer/components/ui/Pager';
import { mockTheme as s1_mockTheme } from '../../../helpers/mockTheme';
/**
 * Tests for TextareaLineNumbers - the scroll-synced, wrap-aware line-number
 * gutter shared by the Auto Run expanded editor and the Cue YAML editor.
 *
 * jsdom has no layout engine, so wrap measurement itself cannot be asserted
 * here. These tests guard the mechanism: one entry per logical line, the
 * numbers track the textarea's scrollTop, and the gutter/text metrics stay in
 * step as the document grows past 9, 99, 999 lines.
 */
import { useRef } from 'react';
import {
	render as s2_render,
	screen as s2_screen,
	fireEvent as s2_fireEvent,
} from '@testing-library/react';
import {
	TextareaLineNumbers,
	lineNumberGutterMetrics,
} from '../../../../renderer/components/ui/TextareaLineNumbers';
import { createMockTheme } from '../../../helpers/mockTheme';
import {
	render as s3_render,
	screen as s3_screen,
	fireEvent as s3_fireEvent,
} from '@testing-library/react';
import { GhostIconButton } from '../../../../renderer/components/ui/GhostIconButton';
import { createRef } from 'react';
import { render as s4_render } from '@testing-library/react';
import { TextareaHighlightOverlay } from '../../../../renderer/components/ui/TextareaHighlightOverlay';
import { mockTheme as s4_mockTheme } from '../../../helpers/mockTheme';
import {
	render as s5_render,
	screen as s5_screen,
	fireEvent as s5_fireEvent,
} from '@testing-library/react';
import { ToggleSwitch, ToggleSwitchTrack } from '../../../../renderer/components/ui/ToggleSwitch';
import { mockTheme as s5_mockTheme } from '../../../helpers/mockTheme';
import { render as s6_render, screen as s6_screen } from '@testing-library/react';
import { HeaderActionButton } from '../../../../renderer/components/ui/HeaderActionButton';
import { mockTheme as s6_mockTheme } from '../../../helpers/mockTheme';
/**
 * Tests for ProviderAvailabilityBar - the shared count + "Show All" toggle that
 * sits above both provider pickers.
 */
import {
	fireEvent as s7_fireEvent,
	render as s7_render,
	screen as s7_screen,
} from '@testing-library/react';
import { ProviderAvailabilityBar } from '../../../../renderer/components/ui/ProviderAvailabilityBar';
import { mockTheme as s7_mockTheme } from '../../../helpers/mockTheme';
/**
 * Tests for ShortcutHint - the shared key-cap chip and pinned hint row that
 * advertise a keyboard shortcut next to the control it fires.
 *
 * The chord is formatted through the real formatter so these assertions hold on
 * both macOS ('⌘ ⇧ R') and Windows/Linux ('Ctrl+Shift+R').
 */
import { render as s8_render, screen as s8_screen } from '@testing-library/react';
import {
	ShortcutHint,
	ShortcutKeys,
	shortcutSuffix,
	shortcutText,
} from '../../../../renderer/components/ui/ShortcutHint';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';
import { mockTheme as s8_mockTheme } from '../../../helpers/mockTheme';
/**
 * @file HoverTooltip.test.tsx
 * @description Tests for the portaled hover tooltip.
 *
 * Every tooltip must remain inside the viewport. Callers may use `maxWidth`
 * to request a narrower wrapping boundary, but not to exceed the viewport cap.
 */
import React from 'react';
import {
	render as s9_render,
	screen as s9_screen,
	fireEvent as s9_fireEvent,
} from '@testing-library/react';
import { HoverTooltip } from '../../../../renderer/components/ui/HoverTooltip';
import { mockTheme as s9_mockTheme } from '../../../helpers/mockTheme';
import { render as s10_render, screen as s10_screen } from '@testing-library/react';
import { EmptyStatePlaceholder } from '../../../../renderer/components/ui/EmptyStatePlaceholder';
import type { Theme } from '../../../../renderer/types';
/**
 * Tests for CountBadge - the shared numeric pill (tab-group panel count).
 */
import { render as s11_render } from '@testing-library/react';
import { CountBadge } from '../../../../renderer/components/ui/CountBadge';
import { mockTheme as s11_mockTheme } from '../../../helpers/mockTheme';
/**
 * Tests for CornerDot - the shared corner pip (unread red dot, busy pulse).
 */
import { render as s12_render } from '@testing-library/react';
import { CornerDot } from '../../../../renderer/components/ui/CornerDot';
import '@testing-library/jest-dom';
import { render as s13_render, screen as s13_screen } from '@testing-library/react';
import { SafeSvgIcon } from '../../../../renderer/components/ui/SafeSvgIcon';
vi.mock('lucide-react', () => ({
	ChevronLeft: () => <span data-testid="chevron-left" />,
	ChevronRight: () => <span data-testid="chevron-right" />,
}));
// Source: src/__tests__/renderer/components/ui/Pager.test.tsx
describe('', () => {
	const renderPager = (overrides: Partial<React.ComponentProps<typeof Pager>> = {}) => {
		const onPrev = vi.fn();
		const onNext = vi.fn();
		s1_render(
			<Pager
				theme={s1_mockTheme}
				page={2}
				totalPages={5}
				onPrev={onPrev}
				onNext={onNext}
				canGoPrev
				canGoNext
				testId="pager"
				{...overrides}
			/>
		);
		return { onPrev, onNext };
	};
	describe('Pager', () => {
		it('renders the current page against the total', () => {
			renderPager();
			expect(s1_screen.getByTestId('pager-label')).toHaveTextContent('2 / 5');
		});
		it('announces page changes to assistive tech', () => {
			renderPager();
			// Focus never moves when the page turns, so without a live region a
			// screen reader user gets no signal that the list changed.
			expect(s1_screen.getByTestId('pager-label')).toHaveAttribute('aria-live', 'polite');
		});
		it('reports prev and next clicks', () => {
			const { onPrev, onNext } = renderPager();
			s1_fireEvent.click(s1_screen.getByTestId('pager-next'));
			expect(onNext).toHaveBeenCalledTimes(1);
			s1_fireEvent.click(s1_screen.getByTestId('pager-prev'));
			expect(onPrev).toHaveBeenCalledTimes(1);
		});
		it('disables prev on the first page and next on the last', () => {
			const { onPrev } = renderPager({ page: 1, canGoPrev: false });
			const prev = s1_screen.getByTestId('pager-prev');
			expect(prev).toBeDisabled();
			s1_fireEvent.click(prev);
			expect(onPrev).not.toHaveBeenCalled();
		});
		it('disables next at the end', () => {
			const { onNext } = renderPager({ page: 5, canGoNext: false });
			const next = s1_screen.getByTestId('pager-next');
			expect(next).toBeDisabled();
			s1_fireEvent.click(next);
			expect(onNext).not.toHaveBeenCalled();
		});
		it('pages with the arrow keys', () => {
			const { onPrev, onNext } = renderPager();
			const group = s1_screen.getByRole('group', { name: 'Pagination' });
			s1_fireEvent.keyDown(group, { key: 'ArrowRight' });
			expect(onNext).toHaveBeenCalledTimes(1);
			s1_fireEvent.keyDown(group, { key: 'ArrowLeft' });
			expect(onPrev).toHaveBeenCalledTimes(1);
		});
		it('ignores arrow keys that would run past an edge', () => {
			const { onPrev } = renderPager({ page: 1, canGoPrev: false });
			const group = s1_screen.getByRole('group', { name: 'Pagination' });
			s1_fireEvent.keyDown(group, { key: 'ArrowLeft' });
			expect(onPrev).not.toHaveBeenCalled();
		});
		it('leaves other keys to the host surface', () => {
			const { onPrev, onNext } = renderPager();
			const group = s1_screen.getByRole('group', { name: 'Pagination' });
			s1_fireEvent.keyDown(group, { key: 'Escape' });
			s1_fireEvent.keyDown(group, { key: 'ArrowUp' });
			expect(onPrev).not.toHaveBeenCalled();
			expect(onNext).not.toHaveBeenCalled();
		});
		it('accepts a surface-specific group label', () => {
			renderPager({ ariaLabel: 'Tab pages' });
			expect(s1_screen.getByRole('group', { name: 'Tab pages' })).toBeInTheDocument();
		});
	});
});
// Source: src/__tests__/renderer/components/ui/TextareaLineNumbers.test.tsx
describe('', () => {
	function Harness({
		value,
		fontSize,
		remeasureKey,
	}: {
		value: string;
		fontSize?: string;
		remeasureKey?: string | number;
	}) {
		const ref = useRef<HTMLTextAreaElement>(null);
		return (
			<div className="relative">
				<TextareaLineNumbers
					textareaRef={ref}
					value={value}
					theme={createMockTheme()}
					remeasureKey={remeasureKey}
				/>
				<textarea
					ref={ref}
					data-testid="editor"
					value={value}
					readOnly
					style={{
						paddingLeft: lineNumberGutterMetrics(value).textPaddingLeft,
						...(fontSize ? { fontSize } : {}),
					}}
				/>
			</div>
		);
	}
	describe('lineNumberGutterMetrics', () => {
		it('reserves at least two digits so a short document does not reflow on line 10', () => {
			expect(lineNumberGutterMetrics('one').digits).toBe(2);
			expect(lineNumberGutterMetrics('a\nb\nc').digits).toBe(2);
		});
		it('widens with the line count', () => {
			const hundred = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
			const thousand = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
			expect(lineNumberGutterMetrics(hundred).digits).toBe(3);
			expect(lineNumberGutterMetrics(thousand).digits).toBe(4);
		});
		it('keeps the text padding wider than the gutter so digits never touch the text', () => {
			const metrics = lineNumberGutterMetrics('a\nb');
			expect(metrics.gutterWidth).toBe('calc(2ch + 18px)');
			expect(metrics.textPaddingLeft).toBe('calc(2ch + 24px)');
		});
	});
	describe('TextareaLineNumbers', () => {
		it('renders one number per logical line', () => {
			s2_render(<Harness value={'first\nsecond\nthird'} />);
			const gutter = s2_screen.getByTestId('line-numbers');
			expect(gutter.textContent).toBe('123');
		});
		it('counts the trailing blank line a newline creates', () => {
			s2_render(<Harness value={'first\n'} />);
			expect(s2_screen.getByTestId('line-numbers').textContent).toBe('12');
		});
		it('hides the gutter from assistive tech - it labels the textarea, it is not content', () => {
			s2_render(<Harness value={'a'} />);
			expect(s2_screen.getByTestId('line-numbers')).toHaveAttribute('aria-hidden', 'true');
		});
		it('translates the numbers by the textarea scroll position', () => {
			s2_render(<Harness value={'a\nb\nc'} />);
			const textarea = s2_screen.getByTestId('editor');
			const rows = s2_screen.getByTestId('line-numbers').firstElementChild as HTMLElement;
			expect(rows.style.transform).toBe('translateY(0px)');
			Object.defineProperty(textarea, 'scrollTop', { value: 42, configurable: true });
			s2_fireEvent.scroll(textarea);
			expect(rows.style.transform).toBe('translateY(-42px)');
		});
		it('pushes the textarea text clear of the gutter', () => {
			s2_render(<Harness value={'a\nb'} />);
			expect(s2_screen.getByTestId('editor')).toHaveStyle({ paddingLeft: 'calc(2ch + 24px)' });
		});
		describe('remeasureKey', () => {
			// The gutter is a sibling rendered BEFORE the textarea, so its layout effect
			// runs while `textareaRef.current` is still null and the mount pass measures
			// nothing. The first real measurement therefore lands on the first re-run,
			// which is what these tests drive with the key.
			it('re-mirrors the textarea typography when the key changes', () => {
				const { rerender } = s2_render(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1} />);
				rerender(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1.1} />);
				expect(s2_screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });
				rerender(<Harness value={'a\nb'} fontSize="21px" remeasureKey={1.5} />);
				expect(s2_screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '21px' });
			});
			it('holds the old typography when the key does not move - the bug the prop exists for', () => {
				// A font-size change leaves the border box the same size, so the
				// component's own ResizeObserver never fires. With nothing in the deps to
				// notice, the gutter keeps the previous font until something else re-runs
				// the measurement.
				const { rerender } = s2_render(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1} />);
				rerender(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1.1} />);
				expect(s2_screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });
				rerender(<Harness value={'a\nb'} fontSize="21px" remeasureKey={1.1} />);
				expect(s2_screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });
			});
		});
	});
});
// Source: src/__tests__/renderer/components/ui/GhostIconButton.test.tsx
describe('', () => {
	describe('GhostIconButton', () => {
		it('renders children and default classes', () => {
			s3_render(
				<GhostIconButton ariaLabel="Close">
					<span data-testid="icon">x</span>
				</GhostIconButton>
			);
			const btn = s3_screen.getByRole('button', { name: 'Close' });
			expect(btn).toBeInTheDocument();
			expect(btn).toHaveClass('rounded');
			expect(btn).toHaveClass('hover:bg-white/10');
			expect(btn).toHaveClass('p-1');
			expect(s3_screen.getByTestId('icon')).toBeInTheDocument();
		});
		it('centers its icon rather than baseline-aligning it', () => {
			s3_render(
				<GhostIconButton ariaLabel="Centered">
					<span>x</span>
				</GhostIconButton>
			);
			// jsdom has no layout engine, so this guards the mechanism rather than the
			// pixels: without these the icon becomes inline content on the line box's
			// baseline, the button's height is driven by the inherited line-height
			// instead of the icon, and the icon rides above the center of its own
			// hover pill.
			const btn = s3_screen.getByRole('button', { name: 'Centered' });
			expect(btn).toHaveClass('inline-flex');
			expect(btn).toHaveClass('items-center');
			expect(btn).toHaveClass('justify-center');
		});
		it('calls onClick when clicked', () => {
			const onClick = vi.fn();
			s3_render(
				<GhostIconButton onClick={onClick} ariaLabel="Do it">
					<span>x</span>
				</GhostIconButton>
			);
			s3_fireEvent.click(s3_screen.getByRole('button', { name: 'Do it' }));
			expect(onClick).toHaveBeenCalledTimes(1);
		});
		it('respects disabled prop', () => {
			const onClick = vi.fn();
			s3_render(
				<GhostIconButton onClick={onClick} disabled ariaLabel="Disabled">
					<span>x</span>
				</GhostIconButton>
			);
			const btn = s3_screen.getByRole('button', { name: 'Disabled' });
			expect(btn).toBeDisabled();
			s3_fireEvent.click(btn);
			expect(onClick).not.toHaveBeenCalled();
		});
		it('applies custom padding', () => {
			s3_render(
				<GhostIconButton padding="p-2" ariaLabel="Pad">
					<span>x</span>
				</GhostIconButton>
			);
			expect(s3_screen.getByRole('button', { name: 'Pad' })).toHaveClass('p-2');
		});
		it('announces its state when used as a toggle', () => {
			const { rerender } = s3_render(
				<GhostIconButton pressed ariaLabel="Show tool calls">
					<span>x</span>
				</GhostIconButton>
			);
			expect(s3_screen.getByRole('button', { name: 'Show tool calls' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			rerender(
				<GhostIconButton pressed={false} ariaLabel="Show tool calls">
					<span>x</span>
				</GhostIconButton>
			);
			expect(s3_screen.getByRole('button', { name: 'Show tool calls' })).toHaveAttribute(
				'aria-pressed',
				'false'
			);
		});
		it('stays a plain button when `pressed` is omitted', () => {
			// `aria-pressed="false"` on a button that does not toggle is a lie about
			// what it does, so an ordinary action button must carry no attribute.
			s3_render(
				<GhostIconButton ariaLabel="Close">
					<span>x</span>
				</GhostIconButton>
			);
			expect(s3_screen.getByRole('button', { name: 'Close' })).not.toHaveAttribute('aria-pressed');
		});
		it('stops propagation when stopPropagation is true', () => {
			const parentClick = vi.fn();
			const onClick = vi.fn();
			s3_render(
				<div onClick={parentClick}>
					<GhostIconButton onClick={onClick} stopPropagation ariaLabel="Stop">
						<span>x</span>
					</GhostIconButton>
				</div>
			);
			s3_fireEvent.click(s3_screen.getByRole('button', { name: 'Stop' }));
			expect(onClick).toHaveBeenCalledTimes(1);
			expect(parentClick).not.toHaveBeenCalled();
		});
	});
});
// Source: src/__tests__/renderer/components/ui/TextareaHighlightOverlay.test.tsx
describe('', () => {
	function renderOverlay(value: string, query: string) {
		const ref = createRef<HTMLTextAreaElement>();
		const utils = s4_render(
			<div className="dual-pane-highlight-wrap">
				<TextareaHighlightOverlay
					textareaRef={ref}
					value={value}
					query={query}
					theme={s4_mockTheme}
					backgroundColor="#101010"
				/>
				<textarea ref={ref} readOnly value={value} />
			</div>
		);
		const backdrop = utils.container.querySelector('.dual-pane-highlight-backdrop');
		return { ...utils, backdrop, ref };
	}
	describe('TextareaHighlightOverlay', () => {
		it('renders nothing at all without a query', () => {
			// No marks to paint, so the editor should not carry an invisible copy of
			// its own document.
			const { backdrop } = renderOverlay('some text', '');
			expect(backdrop).toBeNull();
		});
		it('marks every occurrence of the query', () => {
			const { backdrop } = renderOverlay('pedram and pedram again', 'pedram');
			const marks = backdrop!.querySelectorAll('mark');
			expect(marks).toHaveLength(2);
			expect(Array.from(marks, (m) => m.textContent)).toEqual(['pedram', 'pedram']);
		});
		it('matches case-insensitively while preserving the original casing', () => {
			const { backdrop } = renderOverlay('Pedram', 'pedram');
			expect(backdrop!.querySelector('mark')?.textContent).toBe('Pedram');
		});
		it('paints only a background - every glyph it owns is transparent', () => {
			// If the backdrop drew visible text it would double every character,
			// slightly offset, which reads as a rendering fault.
			const { backdrop } = renderOverlay('ask pedram now', 'pedram');
			const mark = backdrop!.querySelector('mark') as HTMLElement;
			expect(mark.style.color).toBe('transparent');
			expect(mark.style.backgroundColor).toBeTruthy();
			for (const span of Array.from(backdrop!.querySelectorAll('span'))) {
				expect((span as HTMLElement).style.color).toBe('transparent');
			}
		});
		it('reproduces the document exactly, so marks line up with the text above', () => {
			const text = 'alpha pedram\nbeta\n\ngamma pedram';
			const { backdrop } = renderOverlay(text, 'pedram');
			// A trailing newline is appended so a document ending in one keeps its
			// last row; everything before it must match the source character for
			// character.
			expect(backdrop!.textContent?.startsWith(text)).toBe(true);
		});
		it('is hidden from assistive tech and from the pointer', () => {
			const { backdrop } = renderOverlay('pedram', 'pedram');
			expect(backdrop!.getAttribute('aria-hidden')).toBe('true');
			// pointer-events comes from the stylesheet, which jsdom does not load, so
			// assert the class that carries it rather than the computed value.
			expect(backdrop!.className).toContain('dual-pane-highlight-backdrop');
		});
		it('carries the editor fill, since the textarea above goes transparent', () => {
			const { backdrop } = renderOverlay('pedram', 'pedram');
			expect((backdrop as HTMLElement).style.backgroundColor).toBeTruthy();
		});
		it('follows the textarea when it scrolls', () => {
			const { backdrop, ref } = renderOverlay('pedram\n'.repeat(50), 'pedram');
			const textarea = ref.current!;
			Object.defineProperty(textarea, 'scrollTop', { value: 120, writable: true });
			textarea.dispatchEvent(new Event('scroll'));
			expect((backdrop as HTMLElement).scrollTop).toBe(120);
		});
		it('survives a query containing regex metacharacters', () => {
			const { backdrop } = renderOverlay('cost $100 today', '$100');
			expect(backdrop!.querySelector('mark')?.textContent).toBe('$100');
		});
		it('renders no marks when the query matches nothing', () => {
			const { backdrop } = renderOverlay('hello world', 'zzz');
			expect(backdrop!.querySelectorAll('mark')).toHaveLength(0);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/ToggleSwitch.test.tsx
describe('', () => {
	/** The pill graphic lives inside the button, so color assertions target it. */
	const trackOf = (toggle: HTMLElement): HTMLElement => toggle.firstElementChild as HTMLElement;
	describe('ToggleSwitch', () => {
		it('renders as a switch with aria-checked reflecting the state', () => {
			s5_render(<ToggleSwitch checked={true} onChange={vi.fn()} theme={s5_mockTheme} />);
			const toggle = s5_screen.getByRole('switch');
			expect(toggle).toHaveAttribute('aria-checked', 'true');
		});
		it('reports the toggled value on click', () => {
			const onChange = vi.fn();
			s5_render(<ToggleSwitch checked={false} onChange={onChange} theme={s5_mockTheme} />);
			s5_fireEvent.click(s5_screen.getByRole('switch'));
			expect(onChange).toHaveBeenCalledWith(true);
		});
		it('exposes ariaLabel and title', () => {
			s5_render(
				<ToggleSwitch
					checked={false}
					onChange={vi.fn()}
					theme={s5_mockTheme}
					ariaLabel="Show commands"
					title="Show in autocomplete"
				/>
			);
			const toggle = s5_screen.getByRole('switch', { name: 'Show commands' });
			expect(toggle).toHaveAttribute('title', 'Show in autocomplete');
		});
		it('does not fire onChange while disabled', () => {
			const onChange = vi.fn();
			s5_render(<ToggleSwitch checked={false} onChange={onChange} theme={s5_mockTheme} disabled />);
			s5_fireEvent.click(s5_screen.getByRole('switch'));
			expect(onChange).not.toHaveBeenCalled();
		});
		it('marks itself busy, shows a spinner, and refuses input while busy', () => {
			const onChange = vi.fn();
			const { container } = s5_render(
				<ToggleSwitch checked={false} onChange={onChange} theme={s5_mockTheme} busy />
			);
			const toggle = s5_screen.getByRole('switch');
			expect(toggle).toHaveAttribute('aria-busy', 'true');
			expect(toggle).toBeDisabled();
			expect(container.querySelector('.animate-spin')).toBeTruthy();
			s5_fireEvent.click(toggle);
			expect(onChange).not.toHaveBeenCalled();
		});
		it('omits aria-busy when it is not busy', () => {
			s5_render(<ToggleSwitch checked={false} onChange={vi.fn()} theme={s5_mockTheme} />);
			expect(s5_screen.getByRole('switch')).not.toHaveAttribute('aria-busy');
		});
		it('uses the theme accent when checked, or activeColor when one is given', () => {
			const { rerender } = s5_render(
				<ToggleSwitch checked={true} onChange={vi.fn()} theme={s5_mockTheme} />
			);
			expect(trackOf(s5_screen.getByRole('switch')).style.backgroundColor).toBe(
				'rgb(189, 147, 249)'
			);
			rerender(
				<ToggleSwitch
					checked={true}
					onChange={vi.fn()}
					theme={s5_mockTheme}
					activeColor="#22c55e"
				/>
			);
			expect(trackOf(s5_screen.getByRole('switch')).style.backgroundColor).toBe('rgb(34, 197, 94)');
		});
		it('renders the compact pill when size is sm', () => {
			const { rerender } = s5_render(
				<ToggleSwitch checked={false} onChange={vi.fn()} theme={s5_mockTheme} />
			);
			expect(trackOf(s5_screen.getByRole('switch')).className).toContain('w-10 h-5');
			rerender(<ToggleSwitch checked={false} onChange={vi.fn()} theme={s5_mockTheme} size="sm" />);
			expect(trackOf(s5_screen.getByRole('switch')).className).toContain('w-8 h-4');
		});
	});
	describe('ToggleSwitchTrack', () => {
		it('renders no click target of its own so it can nest inside a host switch', () => {
			const { container } = s5_render(<ToggleSwitchTrack checked={false} theme={s5_mockTheme} />);
			expect(container.querySelector('button')).toBeNull();
			expect(container.querySelector('[role="switch"]')).toBeNull();
		});
		it('honors inactiveColor for the unchecked track', () => {
			const { container } = s5_render(
				<ToggleSwitchTrack checked={false} theme={s5_mockTheme} inactiveColor="#22c55e" />
			);
			expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe(
				'rgb(34, 197, 94)'
			);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/HeaderActionButton.test.tsx
describe('', () => {
	describe('HeaderActionButton', () => {
		it('renders its label and fires onClick', () => {
			const onClick = vi.fn();
			s6_render(
				<HeaderActionButton theme={s6_mockTheme} onClick={onClick}>
					New Memory
				</HeaderActionButton>
			);
			const button = s6_screen.getByRole('button', { name: 'New Memory' });
			button.click();
			expect(onClick).toHaveBeenCalledTimes(1);
		});
		it('sits one step below the header title rather than matching it', () => {
			s6_render(
				<HeaderActionButton theme={s6_mockTheme} onClick={vi.fn()}>
					New Session
				</HeaderActionButton>
			);
			const button = s6_screen.getByRole('button', { name: 'New Session' });
			expect(button.className).toContain('text-xs');
			expect(button.className).not.toContain('text-sm');
		});
		it('fills with the accent color by default', () => {
			s6_render(
				<HeaderActionButton theme={s6_mockTheme} onClick={vi.fn()}>
					Resume
				</HeaderActionButton>
			);
			const button = s6_screen.getByRole('button', { name: 'Resume' });
			expect(button.style.backgroundColor).toBeTruthy();
		});
		it('renders the ghost variant without an accent fill', () => {
			// A secondary action beside a primary one must not compete with it.
			s6_render(
				<HeaderActionButton theme={s6_mockTheme} onClick={vi.fn()} variant="ghost">
					Graph
				</HeaderActionButton>
			);
			const button = s6_screen.getByRole('button', { name: 'Graph' });
			expect(button.style.backgroundColor).toBe('');
		});
		it('sizes the icon it is given, so callers do not have to', () => {
			s6_render(
				<HeaderActionButton
					theme={s6_mockTheme}
					onClick={vi.fn()}
					icon={<svg data-testid="icon" />}
				>
					New
				</HeaderActionButton>
			);
			const wrapper = s6_screen.getByTestId('icon').parentElement;
			expect(wrapper?.className).toContain('[&>svg]:w-3.5');
		});
		it('does not fire while disabled', () => {
			const onClick = vi.fn();
			s6_render(
				<HeaderActionButton theme={s6_mockTheme} onClick={onClick} disabled>
					New Memory
				</HeaderActionButton>
			);
			const button = s6_screen.getByRole('button', { name: 'New Memory' });
			button.click();
			expect(onClick).not.toHaveBeenCalled();
			expect((button as HTMLButtonElement).disabled).toBe(true);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/ProviderAvailabilityBar.test.tsx
describe('', () => {
	function renderBar(props: Partial<React.ComponentProps<typeof ProviderAvailabilityBar>> = {}): {
		onShowAllChange: ReturnType<typeof vi.fn>;
	} {
		const onShowAllChange = vi.fn();
		s7_render(
			<ProviderAvailabilityBar
				theme={s7_mockTheme}
				availableCount={4}
				totalCount={11}
				locationLabel="locally"
				showAll={false}
				onShowAllChange={onShowAllChange}
				{...props}
			/>
		);
		return { onShowAllChange };
	}
	describe('ProviderAvailabilityBar', () => {
		it('reads as a sentence in the full variant', () => {
			renderBar();
			expect(
				s7_screen.getByText('4 providers available locally of 11 supported')
			).toBeInTheDocument();
			expect(s7_screen.getByText('Show All Supported')).toBeInTheDocument();
		});
		it('drops to bare counts in the compact variant', () => {
			// The full sentence wraps the New Agent modal's section heading onto a
			// second line, which costs a row in a modal that already scrolls.
			renderBar({ variant: 'compact' });
			expect(s7_screen.getByText('4 of 11 locally')).toBeInTheDocument();
			expect(s7_screen.getByText('Show All')).toBeInTheDocument();
		});
		it('names the remote host instead of claiming "locally"', () => {
			// The counts describe whichever machine detection probed.
			renderBar({ locationLabel: 'on build-box' });
			expect(
				s7_screen.getByText('4 providers available on build-box of 11 supported')
			).toBeInTheDocument();
		});
		it('reports the total, not the filtered row count', () => {
			// A count that shrank with the list would read "4 of 4" and answer nothing.
			renderBar({ availableCount: 4, totalCount: 11 });
			expect(s7_screen.queryByText('4 providers available locally of 4 supported')).toBeNull();
		});
		it('toggles and reflects its state', () => {
			const { onShowAllChange } = renderBar();
			const toggle = s7_screen.getByRole('switch', { name: 'Show all supported providers' });
			expect(toggle).toHaveAttribute('aria-checked', 'false');
			s7_fireEvent.click(toggle);
			expect(onShowAllChange).toHaveBeenCalledWith(true);
		});
		it('locks the toggle on and says why when nothing is detected', () => {
			// The picker already shows every row in this case, so a toggle drawn off
			// beside a full list reads as a filter that does not work.
			const { onShowAllChange } = renderBar({ availableCount: 0 });
			expect(
				s7_screen.getByText('No providers detected locally, showing all 11 supported')
			).toBeInTheDocument();
			const toggle = s7_screen.getByRole('switch', { name: 'Show all supported providers' });
			expect(toggle).toHaveAttribute('aria-checked', 'true');
			expect(toggle).toBeDisabled();
			s7_fireEvent.click(toggle);
			expect(onShowAllChange).not.toHaveBeenCalled();
		});
		it('explains the locked toggle in the compact variant', () => {
			renderBar({ availableCount: 0, variant: 'compact' });
			expect(s7_screen.getByText('0 of 11 locally')).toHaveAttribute(
				'title',
				'No providers detected locally. Showing all 11 so you can set a custom path.'
			);
			expect(
				s7_screen.getByRole('switch', { name: 'Show all supported providers' })
			).toBeDisabled();
		});
		it('marks itself exempt so a container keyboard handler leaves its keys alone', () => {
			renderBar();
			const toggle = s7_screen.getByRole('switch', { name: 'Show all supported providers' });
			expect(toggle.closest('[data-provider-bar-nav-exempt]')).not.toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/components/ui/ShortcutHint.test.tsx
describe('', () => {
	const KEYS = ['Meta', 'Shift', 'r'];
	const CHORD = formatShortcutKeys(KEYS);
	describe('ShortcutHint', () => {
		it('renders the chord as a right-aligned chip by default', () => {
			const { container } = s8_render(<ShortcutHint theme={s8_mockTheme} keys={KEYS} />);
			const chip = container.firstElementChild as HTMLElement;
			expect(chip.tagName).toBe('SPAN');
			expect(chip).toHaveTextContent(CHORD);
			expect(chip.className).toContain('ml-auto');
		});
		it('prefixes the chord with a label when one is supplied', () => {
			const { container } = s8_render(
				<ShortcutHint theme={s8_mockTheme} keys={KEYS} label="Try:" />
			);
			expect(s8_screen.getByText('Try:')).toBeInTheDocument();
			expect(container.firstElementChild).toHaveTextContent(`Try: ${CHORD}`);
		});
		// A chip in a narrow menu row must never let its chord wrap into a stack.
		it('never wraps or shrinks', () => {
			const { container } = s8_render(<ShortcutHint theme={s8_mockTheme} keys={KEYS} />);
			const chip = container.firstElementChild as HTMLElement;
			expect(chip.className).toContain('whitespace-nowrap');
			expect(chip.className).toContain('shrink-0');
		});
		// An action can ship unbound. A blank key-cap would advertise a combo that
		// does nothing, so the component renders nothing at all instead.
		it('renders nothing for an unbound action', () => {
			const { container } = s8_render(<ShortcutHint theme={s8_mockTheme} keys={[]} />);
			expect(container).toBeEmptyDOMElement();
		});
		describe('row variant', () => {
			it('renders a non-interactive header that cannot be reached by keyboard', () => {
				const { container } = s8_render(
					<ShortcutHint theme={s8_mockTheme} keys={KEYS} label="Try:" variant="row" />
				);
				const row = container.firstElementChild as HTMLElement;
				expect(row.tagName).toBe('DIV');
				expect(row.closest('button')).toBeNull();
				expect(row).not.toHaveAttribute('tabindex');
				expect(row.className).toContain('select-none');
			});
			// The trailing control must survive on a phone, where every element
			// carrying data-shortcut-hint is hidden - so only the chord carries it.
			it('pins a trailing control at the right end without hiding it with the chord', () => {
				const { container } = s8_render(
					<ShortcutHint
						theme={s8_mockTheme}
						keys={KEYS}
						label="Try:"
						variant="row"
						trailing={<button type="button">Refresh</button>}
					/>
				);
				const row = container.firstElementChild as HTMLElement;
				const button = s8_screen.getByRole('button', { name: 'Refresh' });
				expect(row).not.toHaveAttribute('data-shortcut-hint');
				// rc draws the chord as separate key caps, so read the hint's text
				// content rather than matching one text node.
				const hint = row.querySelector('[data-shortcut-hint]');
				expect(hint).not.toBeNull();
				expect(hint).toHaveTextContent(`Try: ${CHORD}`);
				expect(button.closest('[data-shortcut-hint]')).toBeNull();
			});
			it('still draws the row for a trailing control when the action is unbound', () => {
				s8_render(
					<ShortcutHint
						theme={s8_mockTheme}
						keys={[]}
						variant="row"
						trailing={<button type="button">Refresh</button>}
					/>
				);
				expect(s8_screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
				expect(document.querySelector('[data-shortcut-hint]')).toBeNull();
			});
		});
	});
	describe('ShortcutKeys', () => {
		it('draws one cap per key and reads as the formatted chord', () => {
			const { container } = s8_render(<ShortcutKeys theme={s8_mockTheme} keys={KEYS} />);
			const caps = container.querySelectorAll('kbd');
			expect(caps).toHaveLength(3);
			expect(caps[2]).toHaveTextContent('R');
			expect(container.firstElementChild).toHaveTextContent(CHORD);
			expect(container.firstElementChild).toHaveAttribute('data-shortcut-keys', 'Meta+Shift+r');
		});
		it('draws the caps in the accent color, and never wraps', () => {
			const { container } = s8_render(<ShortcutKeys theme={s8_mockTheme} keys={KEYS} />);
			const root = container.firstElementChild as HTMLElement;
			expect(root.className).toContain('whitespace-nowrap');
			expect(root.className).toContain('shrink-0');
			expect(container.querySelector('kbd')).toHaveStyle({ color: s8_mockTheme.colors.accent });
		});
		it("uses the accent's foreground color on an accent surface", () => {
			const { container } = s8_render(<ShortcutKeys theme={s8_mockTheme} keys={KEYS} onAccent />);
			expect(container.querySelector('kbd')).toHaveStyle({
				color: s8_mockTheme.colors.accentForeground,
			});
		});
		it('joins alternative chords with "or"', () => {
			const { container } = s8_render(
				<ShortcutKeys theme={s8_mockTheme} keys={[['Escape'], ['Meta', 'w']]} />
			);
			expect(container.querySelectorAll('kbd')).toHaveLength(3);
			expect(s8_screen.getByText('or')).toBeInTheDocument();
			expect(container.firstElementChild).toHaveAttribute('data-shortcut-keys', 'Escape | Meta+w');
		});
		it('renders nothing for no keys', () => {
			const { container } = s8_render(<ShortcutKeys theme={s8_mockTheme} keys={[]} />);
			expect(container).toBeEmptyDOMElement();
		});
	});
	describe('shortcutText', () => {
		it('formats chords for a native title and passes a string through', () => {
			expect(shortcutText(KEYS)).toBe(CHORD);
			expect(shortcutText([['Escape'], KEYS])).toBe(
				`${formatShortcutKeys(['Escape'])} or ${CHORD}`
			);
			expect(shortcutText('+')).toBe('+');
			expect(shortcutText(undefined)).toBe('');
		});
	});
	describe('shortcutSuffix', () => {
		it('wraps a bound chord in parentheses with a leading space', () => {
			expect(shortcutSuffix(KEYS)).toBe(` (${CHORD})`);
		});
		// Callers concatenate blindly (`Close tab${shortcutSuffix(keys)}`), so an
		// unbound or missing action must contribute nothing rather than an empty
		// pair of parens.
		it('contributes nothing when the action is unbound', () => {
			expect(shortcutSuffix([])).toBe('');
			expect(shortcutSuffix(undefined)).toBe('');
		});
	});
});
// Source: src/__tests__/renderer/components/ui/HoverTooltip.test.tsx
describe('', () => {
	function open(ui: React.ReactElement) {
		s9_render(ui);
		s9_fireEvent.mouseEnter(s9_screen.getByText('trigger').parentElement!);
		return s9_screen.getByRole('tooltip');
	}
	describe('HoverTooltip', () => {
		it('keeps every tooltip within the viewport by default', () => {
			const original = window.innerWidth;
			Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true });
			try {
				const tip = open(
					<HoverTooltip
						theme={s9_mockTheme}
						label="A default tooltip can contain enough text to exceed the available viewport width."
					>
						<span>trigger</span>
					</HoverTooltip>
				);
				expect(tip.className).not.toContain('whitespace-nowrap');
				expect(tip.style.maxWidth).toBe('184px');
			} finally {
				Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
			}
		});
		it('preserves the single-line label alignment and line height with a nonshrinking shortcut', () => {
			const tip = open(
				<HoverTooltip theme={s9_mockTheme} label="Run" shortcut="Ctrl+Enter">
					<span>trigger</span>
				</HoverTooltip>
			);
			expect(tip.className).toContain('items-center');
			expect(tip.className).not.toContain('leading-snug');
			expect(s9_screen.getByText('Ctrl+Enter').className).toContain('shrink-0');
		});
		// Sentence-length labels must wrap; position clamping alone cannot keep a
		// non-wrapping tooltip inside the viewport.
		it('wraps and caps its width when given a maxWidth', () => {
			const tip = open(
				<HoverTooltip
					theme={s9_mockTheme}
					maxWidth={260}
					label="Mark that you checked this entry yourself. Entirely optional, and only a bookmark for your own review pass."
				>
					<span>trigger</span>
				</HoverTooltip>
			);
			expect(tip.className).not.toContain('whitespace-nowrap');
			expect(tip.style.maxWidth).toBe('260px');
		});
		it('never lets the cap exceed the window, so the clamp has room to work', () => {
			const original = window.innerWidth;
			Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true });
			try {
				const tip = open(
					<HoverTooltip theme={s9_mockTheme} maxWidth={600} label="A long explanatory sentence.">
						<span>trigger</span>
					</HoverTooltip>
				);
				// 200 minus the 8px viewport margin on each side.
				expect(tip.style.maxWidth).toBe('184px');
			} finally {
				Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
			}
		});
		// A wrapping label column used to squeeze the shortcut until `⌘ J` broke at
		// its space and the keys stacked vertically.
		it('draws the shortcut as key caps that never wrap beside a wrapping label', () => {
			const tip = open(
				<HoverTooltip
					theme={s9_mockTheme}
					maxWidth={260}
					label="Choose the tab. Maestro finds the tab that fits your message."
					shortcut={['Meta', 'j']}
				>
					<span>trigger</span>
				</HoverTooltip>
			);
			const chord = tip.querySelector('[data-shortcut-keys]') as HTMLElement;
			expect(chord).toHaveAttribute('data-shortcut-keys', 'Meta+j');
			expect(chord.className).toContain('whitespace-nowrap');
			expect(chord.className).toContain('shrink-0');
			expect(chord.querySelectorAll('kbd')).toHaveLength(2);
		});
		it('draws a string shortcut as one cap', () => {
			const tip = open(
				<HoverTooltip theme={s9_mockTheme} label="Cancel" shortcut="Esc">
					<span>trigger</span>
				</HoverTooltip>
			);
			expect(tip.querySelectorAll('kbd')).toHaveLength(1);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/EmptyStatePlaceholder.test.tsx
describe('', () => {
	const mockTheme: Theme = {
		id: 'test-theme',
		name: 'Test Theme',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#242424',
			bgActivity: '#2a2a2a',
			textMain: '#ffffff',
			textDim: '#888888',
			accent: '#3b82f6',
			accentForeground: '#ffffff',
			border: '#333333',
			error: '#ef4444',
			success: '#22c55e',
			warning: '#f59e0b',
			cursor: '#ffffff',
			terminalBg: '#1a1a1a',
		},
	};
	describe('EmptyStatePlaceholder', () => {
		it('renders title only', () => {
			s10_render(<EmptyStatePlaceholder theme={mockTheme} title="No items" />);
			expect(s10_screen.getByText('No items')).toBeInTheDocument();
		});
		it('renders icon when provided', () => {
			s10_render(
				<EmptyStatePlaceholder
					theme={mockTheme}
					title="No items"
					icon={<svg data-testid="icon" />}
				/>
			);
			expect(s10_screen.getByTestId('icon')).toBeInTheDocument();
		});
		it('renders description when provided', () => {
			s10_render(
				<EmptyStatePlaceholder
					theme={mockTheme}
					title="Empty"
					description="Try adjusting your filters"
				/>
			);
			expect(s10_screen.getByText('Try adjusting your filters')).toBeInTheDocument();
		});
		it('renders action when provided', () => {
			s10_render(
				<EmptyStatePlaceholder theme={mockTheme} title="Empty" action={<button>Clear</button>} />
			);
			expect(s10_screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
		});
	});
});
// Source: src/__tests__/renderer/components/ui/CountBadge.test.tsx
describe('', () => {
	function renderBadge(props: Partial<React.ComponentProps<typeof CountBadge>> = {}) {
		const { container } = s11_render(
			<CountBadge count={3} theme={s11_mockTheme} label="panel" {...props} />
		);
		return container.firstElementChild as HTMLElement;
	}
	describe('CountBadge', () => {
		it('renders the count', () => {
			expect(renderBadge().textContent).toBe('3');
		});
		it('renders a zero rather than hiding itself - showing it is the caller call', () => {
			expect(renderBadge({ count: 0 }).textContent).toBe('0');
		});
		it('announces the count with its noun so a screen reader hears more than a digit', () => {
			const badge = renderBadge();
			expect(badge.getAttribute('aria-label')).toBe('3 panels');
			expect(badge.getAttribute('title')).toBe('3 panels');
		});
		it('uses the singular at one', () => {
			expect(renderBadge({ count: 1 }).getAttribute('aria-label')).toBe('1 panel');
		});
		it('caps the display at max but still announces the true count', () => {
			const badge = renderBadge({ count: 250, max: 99 });
			expect(badge.textContent).toBe('99+');
			expect(badge.getAttribute('aria-label')).toBe('250 panels');
		});
		it('does not cap at exactly max', () => {
			expect(renderBadge({ count: 99, max: 99 }).textContent).toBe('99');
		});
		it('uses tabular numerals so the pill does not jitter as the count changes', () => {
			expect(renderBadge().className).toContain('tabular-nums');
		});
		it('takes the theme accent, and lets a caller override style', () => {
			const badge = renderBadge({ style: { opacity: '0.5' } });
			expect(badge.style.color).toBeTruthy();
			expect(badge.style.opacity).toBe('0.5');
		});
		it('passes through className and data-testid', () => {
			const badge = renderBadge({ className: 'ml-1', 'data-testid': 'panel-count' });
			expect(badge.className).toContain('ml-1');
			expect(badge.getAttribute('data-testid')).toBe('panel-count');
		});
	});
});
// Source: src/__tests__/renderer/components/ui/CornerDot.test.tsx
describe('', () => {
	function renderDot(props: Partial<React.ComponentProps<typeof CornerDot>> = {}) {
		const { container } = s12_render(<CornerDot color="#ff0000" {...props} />);
		return container.firstElementChild as HTMLElement;
	}
	describe('CornerDot', () => {
		it('defaults to a small steady dot in the top-right corner', () => {
			const dot = renderDot();
			expect(dot.className).toContain('w-1.5');
			expect(dot.className).toContain('-top-0.5');
			expect(dot.className).toContain('-right-0.5');
			expect(dot.className).not.toContain('animate-pulse');
			expect(dot).toHaveStyle({ backgroundColor: '#ff0000' });
		});
		it('pulses and grows on request', () => {
			const dot = renderDot({ pulse: true, size: 'md' });
			expect(dot.className).toContain('animate-pulse');
			expect(dot.className).toContain('w-2');
		});
		it('hangs off the right edge when placement is right', () => {
			const dot = renderDot({ placement: 'right' });
			expect(dot.className).toContain('top-1/2');
			expect(dot.className).not.toContain('-top-0.5');
		});
		it('rings the dot so it reads on top of a filled parent', () => {
			expect(renderDot({ ringColor: '#123456' })).toHaveStyle({
				boxShadow: '0 0 0 1.5px #123456',
			});
		});
		// The dot repeats what its parent already says, so it stays out of the
		// a11y tree unless a title gives it something of its own to announce.
		it('is aria-hidden without a title and announced with one', () => {
			expect(renderDot().getAttribute('aria-hidden')).toBe('true');
			const titled = renderDot({ title: 'Unread messages' });
			expect(titled.getAttribute('aria-hidden')).toBeNull();
			expect(titled.getAttribute('title')).toBe('Unread messages');
		});
		// pointer-events-none would suppress the native title tooltip entirely.
		it('does not disable pointer events', () => {
			expect(renderDot({ title: 'Unread messages' }).className).not.toContain(
				'pointer-events-none'
			);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/SafeSvgIcon.test.tsx
describe('', () => {
	describe('SafeSvgIcon', () => {
		it('renders host-owned SVG markup containing only the contributed path data', () => {
			s13_render(<SafeSvgIcon data-testid="safe-svg-icon" path="M3 12H21" viewBox="0 0 24 24" />);
			const svg = s13_screen.getByTestId('safe-svg-icon');
			expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
			expect(svg).toHaveAttribute('fill', 'none');
			expect(svg).toHaveAttribute('stroke', 'currentColor');
			expect(svg.querySelectorAll('path')).toHaveLength(1);
			expect(svg.querySelector('path')).toHaveAttribute('d', 'M3 12H21');
			expect(svg.querySelector('script, foreignObject, image, use')).toBeNull();
		});
	});
});
