// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/ui/KeyValueRows.test.tsx
// Source: src/__tests__/renderer/components/ui/PhoneBottomSheet.test.tsx
// Source: src/__tests__/renderer/components/ui/FontScaleControl.test.tsx
// Source: src/__tests__/renderer/components/ui/FilterInput.test.tsx
// Source: src/__tests__/renderer/components/ui/SortableTh.test.tsx
// Source: src/__tests__/renderer/components/ui/CollapsedCommandsNotice.test.tsx
// Source: src/__tests__/renderer/components/ui/TurnSettingPills.test.tsx
// Source: src/__tests__/renderer/components/ui/Spinner.test.tsx
// Source: src/__tests__/renderer/components/ui/FormInput.test.tsx
// Source: src/__tests__/renderer/components/ui/SegmentedControl.test.tsx
// Source: src/__tests__/renderer/components/ui/MiniBadge.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
/**
 * Tests for KeyValueRows - the shared editable `key = value` list behind an SSH
 * remote's environment variables and its extra `ssh -o` options.
 *
 * The two behaviours worth locking down are the ones a reimplementation gets
 * wrong: rows are keyed by a stable `id` rather than by the editable key text
 * (keying by the text remounts the input on every keystroke and the caret jumps
 * out after one character), and `keyValueRowsToRecords` returns `undefined`
 * rather than `{}` so a section the user emptied stores no key at all.
 *
 * The third is the eye: a parked row keeps its value in a SECOND record so it
 * can be switched back on later without the user stashing the string somewhere.
 */
import {
	fireEvent as s1_fireEvent,
	render as s1_render,
	screen as s1_screen,
} from '@testing-library/react';
import {
	KeyValueRows,
	keyValueRowsToRecords,
	recordToKeyValueRows,
	type KeyValueRow,
} from '../../../../renderer/components/ui/KeyValueRows';
import { mockTheme as s1_mockTheme } from '../../../helpers/mockTheme';
import {
	render as s2_render,
	screen as s2_screen,
	fireEvent as s2_fireEvent,
} from '@testing-library/react';
import {
	PhoneBottomSheet,
	PHONE_SHEET_SCRIM_ARM_MS,
} from '../../../../renderer/components/ui/PhoneBottomSheet';
import { mockTheme as s2_mockTheme } from '../../../helpers/mockTheme';
import {
	render as s3_render,
	screen as s3_screen,
	fireEvent as s3_fireEvent,
} from '@testing-library/react';
import { FontScaleControl } from '../../../../renderer/components/ui/FontScaleControl';
import type { UseFontScaleReturn } from '../../../../renderer/hooks/ui/useFontScale';
import { mockTheme as s3_mockTheme } from '../../../helpers/mockTheme';
import {
	render as s4_render,
	screen as s4_screen,
	fireEvent as s4_fireEvent,
} from '@testing-library/react';
import { FilterInput } from '../../../../renderer/components/ui/FilterInput';
import { mockTheme as s4_mockTheme } from '../../../helpers/mockTheme';
import {
	render as s5_render,
	screen as s5_screen,
	fireEvent as s5_fireEvent,
} from '@testing-library/react';
import { SortableTh } from '../../../../renderer/components/ui/SortableTh';
import type { Theme } from '../../../../renderer/types';
import {
	render as s6_render,
	screen as s6_screen,
	fireEvent as s6_fireEvent,
} from '@testing-library/react';
import { CollapsedCommandsNotice } from '../../../../renderer/components/ui/CollapsedCommandsNotice';
import { mockTheme as s6_mockTheme } from '../../../helpers/mockTheme';
/**
 * Tests for TurnSettingPills - the read-only model / effort badges on a turn.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render as s7_render } from '@testing-library/react';
import { TurnSettingPills } from '../../../../renderer/components/ui/TurnSettingPills';
import { mockTheme as s7_mockTheme } from '../../../helpers/mockTheme';
import { render as s8_render, screen as s8_screen } from '@testing-library/react';
import { Spinner } from '../../../../renderer/components/ui/Spinner';
import {
	render as s9_render,
	screen as s9_screen,
	fireEvent as s9_fireEvent,
} from '@testing-library/react';
import React from 'react';
import { FormInput } from '../../../../renderer/components/ui/FormInput';
import { mockTheme as s9_mockTheme } from '../../../helpers/mockTheme';
import {
	render as s10_render,
	screen as s10_screen,
	fireEvent as s10_fireEvent,
} from '@testing-library/react';
import { SegmentedControl } from '../../../../renderer/components/ui/SegmentedControl';
import { mockTheme as s10_mockTheme } from '../../../helpers/mockTheme';
/**
 * Tests for MiniBadge - the shared uppercase text chip ("WT", "Snoozed").
 */
import { render as s11_render } from '@testing-library/react';
import { MiniBadge } from '../../../../renderer/components/ui/MiniBadge';
import { mockTheme as s11_mockTheme } from '../../../helpers/mockTheme';
// Source: src/__tests__/renderer/components/ui/KeyValueRows.test.tsx
describe('', () => {
	const ROWS: KeyValueRow[] = [
		{ id: 0, key: 'ConnectTimeout', value: '45', enabled: true },
		{ id: 1, key: 'ProxyCommand', value: 'cloudflared access ssh --hostname %h', enabled: true },
	];
	function renderRows(props: Partial<React.ComponentProps<typeof KeyValueRows>> = {}) {
		const onChangeRow = vi.fn();
		const onRemoveRow = vi.fn();
		const onAddRow = vi.fn();
		const utils = s1_render(
			<KeyValueRows
				theme={s1_mockTheme}
				label="SSH Options"
				rows={ROWS}
				onChangeRow={onChangeRow}
				onRemoveRow={onRemoveRow}
				onAddRow={onAddRow}
				addLabel="Add Option"
				testId="ssh-options"
				{...props}
			/>
		);
		return { ...utils, onChangeRow, onRemoveRow, onAddRow };
	}
	describe('recordToKeyValueRows', () => {
		it('returns nothing for an absent record', () => {
			expect(recordToKeyValueRows(undefined)).toEqual([]);
		});
		it('preserves the record insertion order and assigns distinct ids', () => {
			const rows = recordToKeyValueRows({ ConnectTimeout: '45', ProxyJump: 'bastion' });
			expect(rows.map((r) => r.key)).toEqual(['ConnectTimeout', 'ProxyJump']);
			expect(new Set(rows.map((r) => r.id)).size).toBe(2);
		});
	});
	describe('keyValueRowsToRecords', () => {
		it('returns undefined rather than an empty object when nothing survives', () => {
			// A section the user emptied must store no key at all; `{}` would write
			// an empty map back into the remote config.
			expect(keyValueRowsToRecords([]).active).toBeUndefined();
			expect(
				keyValueRowsToRecords([{ id: 0, key: '   ', value: 'orphan', enabled: true }]).active
			).toBeUndefined();
		});
		it('drops blank keys and trims the surviving ones', () => {
			expect(
				keyValueRowsToRecords([
					{ id: 0, key: '  ConnectTimeout  ', value: '45', enabled: true },
					{ id: 1, key: '', value: 'dropped', enabled: true },
				]).active
			).toEqual({ ConnectTimeout: '45' });
		});
		it('sorts a parked row into the second record rather than dropping it', () => {
			// The whole point of the eye: the value survives switched off, so it can
			// be turned back on without the user having stashed the string elsewhere.
			const { active, parked } = keyValueRowsToRecords([
				{ id: 0, key: 'ConnectTimeout', value: '45', enabled: true },
				{ id: 1, key: 'ProxyCommand', value: 'tailcat tcABC 22', enabled: false },
			]);
			expect(active).toEqual({ ConnectTimeout: '45' });
			expect(parked).toEqual({ ProxyCommand: 'tailcat tcABC 22' });
		});
		it('round-trips both records through rows and back', () => {
			const rows = recordToKeyValueRows({ ConnectTimeout: '45' }, { ProxyJump: 'bastion' });
			expect(rows.map((r) => r.enabled)).toEqual([true, false]);
			expect(new Set(rows.map((r) => r.id)).size).toBe(2);
			const { active, parked } = keyValueRowsToRecords(rows);
			expect(active).toEqual({ ConnectTimeout: '45' });
			expect(parked).toEqual({ ProxyJump: 'bastion' });
		});
		it('keeps a blank value, which is meaningful for some options', () => {
			expect(
				keyValueRowsToRecords([{ id: 0, key: 'ProxyCommand', value: '', enabled: true }]).active
			).toEqual({
				ProxyCommand: '',
			});
		});
		it('round-trips a record unchanged', () => {
			const record = { ConnectTimeout: '45', ProxyJump: 'bastion' };
			expect(keyValueRowsToRecords(recordToKeyValueRows(record)).active).toEqual(record);
		});
	});
	describe('KeyValueRows', () => {
		it('renders an input pair per row with the current values', () => {
			renderRows();
			expect(s1_screen.getByDisplayValue('ConnectTimeout')).toBeInTheDocument();
			expect(s1_screen.getByDisplayValue('45')).toBeInTheDocument();
			expect(
				s1_screen.getByDisplayValue('cloudflared access ssh --hostname %h')
			).toBeInTheDocument();
		});
		it('reports edits by row id and field, not by position', () => {
			const { onChangeRow } = renderRows();
			s1_fireEvent.change(s1_screen.getByDisplayValue('ConnectTimeout'), {
				target: { value: 'ConnectTimeoutX' },
			});
			expect(onChangeRow).toHaveBeenCalledWith(0, 'key', 'ConnectTimeoutX');
			s1_fireEvent.change(s1_screen.getByDisplayValue('45'), { target: { value: '60' } });
			expect(onChangeRow).toHaveBeenCalledWith(0, 'value', '60');
		});
		it('keeps the same input element across a key edit, so the caret survives', () => {
			// The regression this guards: keying the list by `row.key` gives React a
			// new key on every keystroke, remounting the input and losing focus.
			const { rerender } = renderRows();
			const before = s1_screen.getByDisplayValue('ConnectTimeout');
			rerender(
				<KeyValueRows
					theme={s1_mockTheme}
					label="SSH Options"
					rows={[{ ...ROWS[0], key: 'C' }, ROWS[1]]}
					onChangeRow={vi.fn()}
					onRemoveRow={vi.fn()}
					onAddRow={vi.fn()}
					addLabel="Add Option"
					testId="ssh-options"
				/>
			);
			expect(s1_screen.getByDisplayValue('C')).toBe(before);
		});
		it('removes by row id', () => {
			const { onRemoveRow } = renderRows({ removeLabel: 'Remove option' });
			s1_fireEvent.click(s1_screen.getAllByRole('button', { name: 'Remove option' })[1]);
			expect(onRemoveRow).toHaveBeenCalledWith(1);
		});
		it('offers the add button even when the list is empty', () => {
			const { onAddRow } = renderRows({ rows: [] });
			s1_fireEvent.click(s1_screen.getByRole('button', { name: /Add Option/ }));
			expect(onAddRow).toHaveBeenCalled();
		});
		it('hides the rows when collapsed without discarding them', () => {
			// Collapsed is a display state; the caller still holds the rows, so
			// re-expanding must not have cost the user their edits.
			const { rerender } = renderRows({ collapsed: true });
			expect(s1_screen.queryByDisplayValue('ConnectTimeout')).not.toBeInTheDocument();
			expect(s1_screen.getByRole('button', { name: /Add Option/ })).toBeInTheDocument();
			rerender(
				<KeyValueRows
					theme={s1_mockTheme}
					label="SSH Options"
					rows={ROWS}
					onChangeRow={vi.fn()}
					onRemoveRow={vi.fn()}
					onAddRow={vi.fn()}
					addLabel="Add Option"
					testId="ssh-options"
				/>
			);
			expect(s1_screen.getByDisplayValue('ConnectTimeout')).toBeInTheDocument();
		});
		describe('the parked-row eye', () => {
			it('is hidden when the caller supplies no toggle handler', () => {
				// Without somewhere to keep a parked value there is nothing the button
				// could do, so it is absent rather than rendered dead.
				renderRows();
				expect(s1_screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
			});
			it('reports a toggle by row id', () => {
				const onToggleRow = vi.fn();
				renderRows({ onToggleRow });
				s1_fireEvent.click(s1_screen.getByRole('button', { name: /Disable ProxyCommand/ }));
				expect(onToggleRow).toHaveBeenCalledWith(1);
			});
			it('offers to enable a parked row and names it in the tooltip', () => {
				const onToggleRow = vi.fn();
				renderRows({
					onToggleRow,
					rows: [{ id: 0, key: 'ProxyCommand', value: 'tailcat tcABC 22', enabled: false }],
				});
				s1_fireEvent.click(s1_screen.getByRole('button', { name: /Enable ProxyCommand/ }));
				expect(onToggleRow).toHaveBeenCalledWith(0);
			});
			it('keeps a parked row editable, since parking is not deleting', () => {
				const { onChangeRow } = renderRows({
					onToggleRow: vi.fn(),
					rows: [{ id: 0, key: 'ProxyCommand', value: 'tailcat tcABC 22', enabled: false }],
				});
				const input = s1_screen.getByDisplayValue('tailcat tcABC 22');
				expect(input).not.toBeDisabled();
				s1_fireEvent.change(input, { target: { value: 'tailcat tcXYZ 22' } });
				expect(onChangeRow).toHaveBeenCalledWith(0, 'value', 'tailcat tcXYZ 22');
			});
			it('falls back to the entry noun when the row has no key yet', () => {
				renderRows({
					onToggleRow: vi.fn(),
					entryNoun: 'option',
					rows: [{ id: 0, key: '   ', value: '', enabled: true }],
				});
				expect(s1_screen.getByRole('button', { name: /Disable option/ })).toBeInTheDocument();
			});
		});
		it('renders the label, helper text and test id', () => {
			renderRows({ helperText: 'Passed to ssh as -o KEY=VALUE.' });
			expect(s1_screen.getByText('SSH Options')).toBeInTheDocument();
			expect(s1_screen.getByText('Passed to ssh as -o KEY=VALUE.')).toBeInTheDocument();
			expect(s1_screen.getByTestId('ssh-options')).toBeInTheDocument();
		});
	});
});
// Source: src/__tests__/renderer/components/ui/PhoneBottomSheet.test.tsx
describe('', () => {
	function renderSheet(overrides: Partial<React.ComponentProps<typeof PhoneBottomSheet>> = {}) {
		const props: React.ComponentProps<typeof PhoneBottomSheet> = {
			open: true,
			onClose: vi.fn(),
			theme: s2_mockTheme,
			ariaLabel: 'Test sheet',
			testId: 'test-sheet',
			children: <div data-testid="sheet-content">body</div>,
			...overrides,
		};
		return { ...props, ...s2_render(<PhoneBottomSheet {...props} />) };
	}
	describe('PhoneBottomSheet', () => {
		it('renders nothing while closed', () => {
			renderSheet({ open: false });
			expect(s2_screen.queryByTestId('sheet-content')).not.toBeInTheDocument();
		});
		it('renders the body inside a labelled modal dialog', () => {
			renderSheet();
			const dialog = s2_screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Test sheet');
			expect(s2_screen.getByTestId('sheet-content')).toBeInTheDocument();
		});
		it('caps the panel at the requested height', () => {
			renderSheet({ maxHeight: '50dvh' });
			expect(s2_screen.getByRole('dialog').style.maxHeight).toBe('50dvh');
		});
		it('defaults the panel height to 80dvh', () => {
			renderSheet();
			expect(s2_screen.getByRole('dialog').style.maxHeight).toBe('80dvh');
		});
		it('closes on the close button', () => {
			const onClose = vi.fn();
			renderSheet({ onClose });
			s2_fireEvent.click(s2_screen.getByLabelText('Close'));
			expect(onClose).toHaveBeenCalled();
		});
		it('ignores a scrim tap inside the arm window', () => {
			// A sheet opened by a long-press gets a synthesized click at the finger's
			// position the moment it lifts, which lands on the scrim covering the
			// control. Answering it would close the sheet before it could be read.
			vi.useFakeTimers();
			try {
				const onClose = vi.fn();
				renderSheet({ onClose });
				s2_fireEvent.click(s2_screen.getByTestId('test-sheet'));
				expect(onClose).not.toHaveBeenCalled();
				vi.advanceTimersByTime(PHONE_SHEET_SCRIM_ARM_MS + 1);
				s2_fireEvent.click(s2_screen.getByTestId('test-sheet'));
				expect(onClose).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});
		it('answers a scrim tap immediately when the arm window is zero', () => {
			// A sheet opened by a plain tap has no trailing synthesized click, so
			// arming it would just make the first dismissal feel broken.
			const onClose = vi.fn();
			renderSheet({ onClose, scrimArmMs: 0 });
			s2_fireEvent.click(s2_screen.getByTestId('test-sheet'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});
		it('does not close when the tap lands inside the panel', () => {
			const onClose = vi.fn();
			renderSheet({ onClose, scrimArmMs: 0 });
			s2_fireEvent.click(s2_screen.getByTestId('sheet-content'));
			expect(onClose).not.toHaveBeenCalled();
		});
		it('hands the scrim to scrimRef, not the panel', () => {
			// TabOverlayPortal's click-outside treats anything inside the ref as
			// inside the menu; the scrim spans the screen so the sheet owns its own
			// dismissal.
			const scrimRef = vi.fn();
			renderSheet({ scrimRef });
			expect(scrimRef).toHaveBeenCalledWith(s2_screen.getByTestId('test-sheet'));
		});
		it('applies the caller styling hooks to the scrim and the body', () => {
			renderSheet({ scrimClassName: 'my-scrim', bodyClassName: 'my-body' });
			expect(s2_screen.getByTestId('test-sheet')).toHaveClass('my-scrim');
			expect(s2_screen.getByTestId('sheet-content').parentElement).toHaveClass('my-body');
		});
		it('renders an optional header between the grip and the body', () => {
			renderSheet({ header: <div data-testid="sheet-header">header</div> });
			expect(s2_screen.getByTestId('sheet-header')).toBeInTheDocument();
		});
	});
});
// Source: src/__tests__/renderer/components/ui/FontScaleControl.test.tsx
describe('', () => {
	function makeControl(overrides: Partial<UseFontScaleReturn> = {}): UseFontScaleReturn {
		return {
			fontScale: 1,
			adjustFontScale: vi.fn(),
			resetFontScale: vi.fn(),
			canDecrease: true,
			canIncrease: true,
			...overrides,
		};
	}
	describe('FontScaleControl', () => {
		it('steps the scale in both directions', () => {
			const control = makeControl();
			s3_render(<FontScaleControl theme={s3_mockTheme} control={control} />);
			s3_fireEvent.click(s3_screen.getByLabelText('Increase font size'));
			expect(control.adjustFontScale).toHaveBeenCalledWith(1);
			s3_fireEvent.click(s3_screen.getByLabelText('Decrease font size'));
			expect(control.adjustFontScale).toHaveBeenCalledWith(-1);
		});
		it('disables the button that would leave the supported range', () => {
			const { rerender } = s3_render(
				<FontScaleControl theme={s3_mockTheme} control={makeControl({ canIncrease: false })} />
			);
			expect(s3_screen.getByLabelText('Increase font size')).toBeDisabled();
			expect(s3_screen.getByLabelText('Decrease font size')).not.toBeDisabled();
			rerender(
				<FontScaleControl theme={s3_mockTheme} control={makeControl({ canDecrease: false })} />
			);
			expect(s3_screen.getByLabelText('Decrease font size')).toBeDisabled();
			expect(s3_screen.getByLabelText('Increase font size')).not.toBeDisabled();
		});
		// The percentage doubles as the reset affordance, so it only earns its space
		// once the user has actually zoomed.
		it('hides the percentage at 100% and shows it once zoomed', () => {
			const { rerender } = s3_render(
				<FontScaleControl theme={s3_mockTheme} control={makeControl()} />
			);
			expect(s3_screen.queryByText('100%')).toBeNull();
			const zoomed = makeControl({ fontScale: 1.3 });
			rerender(<FontScaleControl theme={s3_mockTheme} control={zoomed} />);
			s3_fireEvent.click(s3_screen.getByText('130%'));
			expect(zoomed.resetFontScale).toHaveBeenCalledTimes(1);
		});
		// Collapsed, the pill rests as a circle. The buttons must stay MOUNTED (they
		// are only clipped by CSS) so a Tab into them expands it - unmounting them
		// would make the control unreachable from the keyboard.
		it('keeps the buttons mounted behind the collapsed circle', () => {
			s3_render(
				<FontScaleControl
					theme={s3_mockTheme}
					control={makeControl()}
					variant="floating"
					collapsible
					testId="font-scale"
				/>
			);
			expect(s3_screen.getByTestId('font-scale-handle')).toBeInTheDocument();
			expect(s3_screen.getByLabelText('Increase font size')).toBeInTheDocument();
			expect(s3_screen.getByLabelText('Decrease font size')).toBeInTheDocument();
		});
		it('draws no collapsed circle for the inline variant', () => {
			s3_render(
				<FontScaleControl theme={s3_mockTheme} control={makeControl()} testId="font-scale" />
			);
			expect(s3_screen.queryByTestId('font-scale-handle')).toBeNull();
		});
		// A dense `text-xs` button row (the Auto Run mode bar) would be pushed taller
		// by the default squares, so the small size has to actually shrink them.
		it('draws smaller buttons at size="sm"', () => {
			const { rerender } = s3_render(
				<FontScaleControl theme={s3_mockTheme} control={makeControl()} />
			);
			expect(s3_screen.getByLabelText('Increase font size').className).toContain('w-7');
			rerender(<FontScaleControl theme={s3_mockTheme} control={makeControl()} size="sm" />);
			const small = s3_screen.getByLabelText('Increase font size');
			expect(small.className).toContain('w-6');
			expect(small.className).not.toContain('w-7');
		});
		it('names the pane it zooms in its labels', () => {
			s3_render(<FontScaleControl theme={s3_mockTheme} control={makeControl()} target="preview" />);
			expect(s3_screen.getByLabelText('Increase preview font size')).toBeInTheDocument();
			expect(s3_screen.getByLabelText('Decrease preview font size')).toBeInTheDocument();
		});
		it('overlay tooltips replace the native title and name the key', () => {
			s3_render(
				<FontScaleControl
					theme={s3_mockTheme}
					control={makeControl({ fontScale: 1.2 })}
					variant="ghost"
					tooltips="overlay"
					target="text"
					shortcutHint={{ increase: '⌘=', decrease: '⌘-', reset: '⌘0' }}
				/>
			);
			const increase = s3_screen.getByLabelText('Increase text font size');
			expect(increase).not.toHaveAttribute('title');
			s3_fireEvent.mouseEnter(increase.parentElement!);
			expect(s3_screen.getByRole('tooltip')).toHaveTextContent('Increase text font size⌘=');
		});
		it('keeps native titles with the key by default', () => {
			s3_render(
				<FontScaleControl
					theme={s3_mockTheme}
					control={makeControl()}
					target="preview"
					shortcutHint={{ increase: '+' }}
				/>
			);
			expect(s3_screen.getByLabelText('Increase preview font size')).toHaveAttribute(
				'title',
				'Increase preview font size (+)'
			);
		});
		it('the ghost look has no border, matching borderless icon buttons beside it', () => {
			s3_render(<FontScaleControl theme={s3_mockTheme} control={makeControl()} variant="ghost" />);
			expect(s3_screen.getByLabelText('Increase font size').style.border).not.toMatch(/solid/);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/FilterInput.test.tsx
describe('', () => {
	describe('FilterInput', () => {
		it('reports every keystroke to the consumer', () => {
			const onChange = vi.fn();
			s4_render(
				<FilterInput theme={s4_mockTheme} value="" onChange={onChange} placeholder="Filter..." />
			);
			s4_fireEvent.change(s4_screen.getByPlaceholderText('Filter...'), {
				target: { value: 'work' },
			});
			expect(onChange).toHaveBeenCalledWith('work');
		});
		it('hides the clear button until there is something to clear', () => {
			const { rerender } = s4_render(
				<FilterInput theme={s4_mockTheme} value="" onChange={vi.fn()} />
			);
			expect(s4_screen.queryByLabelText('Clear filter')).not.toBeInTheDocument();
			rerender(<FilterInput theme={s4_mockTheme} value="tree" onChange={vi.fn()} />);
			expect(s4_screen.getByLabelText('Clear filter')).toBeInTheDocument();
		});
		it('empties the query from the clear button', () => {
			const onChange = vi.fn();
			s4_render(<FilterInput theme={s4_mockTheme} value="tree" onChange={onChange} />);
			s4_fireEvent.click(s4_screen.getByLabelText('Clear filter'));
			expect(onChange).toHaveBeenCalledWith('');
		});
		it('clears on Escape and stops the key there', () => {
			const onChange = vi.fn();
			s4_render(
				<FilterInput
					theme={s4_mockTheme}
					value="tree"
					onChange={onChange}
					placeholder="Filter..."
				/>
			);
			const event = createEscapeEvent();
			s4_fireEvent(s4_screen.getByPlaceholderText('Filter...'), event);
			expect(onChange).toHaveBeenCalledWith('');
			expect(event.defaultPrevented).toBe(true);
		});
		it('lets Escape through when the box is already empty', () => {
			const onChange = vi.fn();
			const onKeyDown = vi.fn();
			s4_render(
				<FilterInput
					theme={s4_mockTheme}
					value=""
					onChange={onChange}
					onKeyDown={onKeyDown}
					placeholder="Filter..."
				/>
			);
			const event = createEscapeEvent();
			s4_fireEvent(s4_screen.getByPlaceholderText('Filter...'), event);
			expect(onChange).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
			expect(onKeyDown).toHaveBeenCalled();
		});
		it('forwards other keys to the consumer', () => {
			const onKeyDown = vi.fn();
			s4_render(
				<FilterInput
					theme={s4_mockTheme}
					value="tree"
					onChange={vi.fn()}
					onKeyDown={onKeyDown}
					placeholder="Filter..."
				/>
			);
			s4_fireEvent.keyDown(s4_screen.getByPlaceholderText('Filter...'), { key: 'ArrowDown' });
			expect(onKeyDown).toHaveBeenCalled();
		});
		it('renders the result count only when one is supplied', () => {
			const { rerender } = s4_render(
				<FilterInput theme={s4_mockTheme} value="tree" onChange={vi.fn()} />
			);
			expect(s4_screen.queryByText('3/77')).not.toBeInTheDocument();
			rerender(
				<FilterInput theme={s4_mockTheme} value="tree" onChange={vi.fn()} resultLabel="3/77" />
			);
			expect(s4_screen.getByText('3/77')).toBeInTheDocument();
		});
	});
	function createEscapeEvent(): KeyboardEvent {
		return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
	}
});
// Source: src/__tests__/renderer/components/ui/SortableTh.test.tsx
describe('', () => {
	const theme = {
		colors: { textDim: '#888', textMain: '#fff', accent: '#06b6d4', border: '#333' },
	} as unknown as Theme;
	function renderHeader(props: Partial<React.ComponentProps<typeof SortableTh>> = {}) {
		const onSort = vi.fn();
		s5_render(
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
			expect(s5_screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'ascending');
		});
		it('reports descending when the active column is reversed', () => {
			renderHeader({ direction: 'desc' });
			expect(s5_screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'descending');
		});
		it('reports none when another column is the active one', () => {
			renderHeader({ sortKey: 'agent' });
			expect(s5_screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'none');
		});
		it('is a real button, so it is keyboard reachable and activatable', () => {
			// A `<th role="button" onClick>` announces as a button but has no tab
			// stop and no Enter/Space handling - it is unusable by keyboard.
			const { onSort } = renderHeader();
			const button = s5_screen.getByRole('button', { name: 'Next' });
			button.focus();
			expect(button).toHaveFocus();
			s5_fireEvent.click(button);
			expect(onSort).toHaveBeenCalledWith('next');
		});
		it('always lays out the caret so switching columns does not reflow the row', () => {
			renderHeader({ sortKey: 'agent' });
			const caret = s5_screen.getByTestId('th-next').querySelector('svg');
			// Present in the DOM (space reserved) but invisible on an inactive column.
			expect(caret).not.toBeNull();
			expect(caret).toHaveStyle({ opacity: '0' });
		});
	});
});
// Source: src/__tests__/renderer/components/ui/CollapsedCommandsNotice.test.tsx
describe('', () => {
	describe('CollapsedCommandsNotice', () => {
		it('pluralizes the hidden-command count and offers to reveal', () => {
			s6_render(
				<CollapsedCommandsNotice
					theme={s6_mockTheme}
					count={3}
					expanded={false}
					onToggle={vi.fn()}
					sectionName="Spec Kit"
				/>
			);
			expect(s6_screen.getByText('3 Spec Kit commands hidden')).toBeInTheDocument();
			expect(s6_screen.getByText('Show anyway')).toBeInTheDocument();
		});
		it('uses the singular noun for a single command', () => {
			s6_render(
				<CollapsedCommandsNotice
					theme={s6_mockTheme}
					count={1}
					expanded={false}
					onToggle={vi.fn()}
					sectionName="BMAD"
				/>
			);
			expect(s6_screen.getByText('1 BMAD command hidden')).toBeInTheDocument();
		});
		it('shows the collapse affordance and aria-expanded when expanded', () => {
			s6_render(
				<CollapsedCommandsNotice
					theme={s6_mockTheme}
					count={2}
					expanded={true}
					onToggle={vi.fn()}
					sectionName="OpenSpec"
				/>
			);
			expect(s6_screen.getByText('Collapse')).toBeInTheDocument();
			expect(s6_screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
		});
		it('fires onToggle when clicked', () => {
			const onToggle = vi.fn();
			s6_render(
				<CollapsedCommandsNotice
					theme={s6_mockTheme}
					count={2}
					expanded={false}
					onToggle={onToggle}
					sectionName="Spec Kit"
				/>
			);
			s6_fireEvent.click(s6_screen.getByRole('button'));
			expect(onToggle).toHaveBeenCalledTimes(1);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/TurnSettingPills.test.tsx
describe('', () => {
	function renderPills(props: Partial<React.ComponentProps<typeof TurnSettingPills>> = {}) {
		return s7_render(<TurnSettingPills theme={s7_mockTheme} {...props} />);
	}
	describe('TurnSettingPills', () => {
		it('renders nothing when the turn ran on the agent defaults', () => {
			const { container } = renderPills();
			expect(container.firstElementChild).toBeNull();
		});
		it('omits the pill for whichever value is unset rather than guessing', () => {
			const { queryByTestId } = renderPills({ model: 'opus[1m]' });
			expect(queryByTestId('turn-model-pill')).not.toBeNull();
			expect(queryByTestId('turn-effort-pill')).toBeNull();
		});
		it('marks both pills as readouts the phone stylesheet can retire', () => {
			// They share a footer row with controls that cannot yield width (the
			// queued card's Force Send button and its icon cluster), so the phone
			// block in index.css hides everything carrying this attribute. Dropping
			// it here is invisible in jsdom and reappears as overlapping pills on a
			// 390px screen.
			const { getByTestId } = renderPills({ model: 'opus[1m]', effort: 'high' });
			expect(getByTestId('turn-model-pill').hasAttribute('data-turn-setting-pill')).toBe(true);
			expect(getByTestId('turn-effort-pill').hasAttribute('data-turn-setting-pill')).toBe(true);
		});
	});
	describe('TurnSettingPills phone rule', () => {
		// The attribute on the JSX and the rule in the stylesheet are the two
		// halves of one behaviour, and nothing in the type system ties them
		// together: jsdom has no layout engine and never applies index.css, so
		// deleting or renaming either side is silent here and reappears as three
		// overlapping groups in a queued card's footer at 390px.
		it('hides every element carrying the attribute at the phone breakpoint', () => {
			const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8');
			expect(css).toMatch(
				/html\[data-runtime='web-desktop'\]\[data-bp='xs'\] \[data-turn-setting-pill\]\s*\{\s*display:\s*none;/
			);
		});
	});
});
// Source: src/__tests__/renderer/components/ui/Spinner.test.tsx
describe('', () => {
	describe('Spinner', () => {
		it('renders with default size', () => {
			s8_render(<Spinner />);
			const icon = s8_screen.getByRole('status');
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveClass('animate-spin');
			expect(icon).toHaveStyle({ width: '16px', height: '16px' });
		});
		it('applies custom size', () => {
			s8_render(<Spinner size={32} />);
			const icon = s8_screen.getByRole('status');
			expect(icon).toHaveStyle({ width: '32px', height: '32px' });
		});
		it('applies custom color', () => {
			s8_render(<Spinner color="rgb(255, 0, 0)" />);
			const icon = s8_screen.getByRole('status');
			expect(icon).toHaveStyle({ color: 'rgb(255, 0, 0)' });
		});
		it('merges custom className', () => {
			s8_render(<Spinner className="text-blue-500" />);
			const icon = s8_screen.getByRole('status');
			expect(icon).toHaveClass('animate-spin');
			expect(icon).toHaveClass('text-blue-500');
		});
		// Chromium runs a transform animation on an <svg> on the main thread every
		// frame; on a wrapping element it runs on the compositor.
		it('spins a wrapper, never the svg itself', () => {
			s8_render(<Spinner />);
			expect(s8_screen.getByRole('status')).toHaveClass('animate-spin');
			expect(s8_screen.getByTestId('loader2-icon')).not.toHaveClass('animate-spin');
		});
	});
});
// Source: src/__tests__/renderer/components/ui/FormInput.test.tsx
describe('', () => {
	// Mock theme for testing
	describe('FormInput', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});
		afterEach(() => {
			vi.restoreAllMocks();
		});
		describe('rendering', () => {
			it('should render input with required props', () => {
				const onChange = vi.fn();
				s9_render(<FormInput theme={s9_mockTheme} value="test value" onChange={onChange} />);
				const input = s9_screen.getByRole('textbox');
				expect(input).toBeInTheDocument();
				expect(input).toHaveValue('test value');
			});
			it('should render with label when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} label="Agent Name" />
				);
				expect(s9_screen.getByText('Agent Name')).toBeInTheDocument();
				expect(s9_screen.getByLabelText('Agent Name')).toBeInTheDocument();
			});
			it('should render with placeholder when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						placeholder="Enter name..."
					/>
				);
				expect(s9_screen.getByPlaceholderText('Enter name...')).toBeInTheDocument();
			});
			it('should render with helper text when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						helperText="This field is required"
					/>
				);
				expect(s9_screen.getByText('This field is required')).toBeInTheDocument();
			});
			it('should render error message when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						error="Name already exists"
					/>
				);
				const errorMsg = s9_screen.getByText('Name already exists');
				expect(errorMsg).toBeInTheDocument();
				expect(errorMsg).toHaveStyle({ color: s9_mockTheme.colors.error });
			});
			it('should hide helper text when error is shown', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						helperText="Helper text"
						error="Error message"
					/>
				);
				expect(s9_screen.getByText('Error message')).toBeInTheDocument();
				expect(s9_screen.queryByText('Helper text')).not.toBeInTheDocument();
			});
			it('should render addon content when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						addon={<button data-testid="addon-button">Browse</button>}
					/>
				);
				expect(s9_screen.getByTestId('addon-button')).toBeInTheDocument();
			});
			it('should apply testId when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} testId="my-form-input" />
				);
				expect(s9_screen.getByTestId('my-form-input')).toBeInTheDocument();
			});
			it('should apply custom id when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						id="custom-input-id"
						label="My Input"
					/>
				);
				const input = s9_screen.getByLabelText('My Input');
				expect(input).toHaveAttribute('id', 'custom-input-id');
			});
		});
		describe('styling', () => {
			it('should apply theme border color normally', () => {
				const onChange = vi.fn();
				s9_render(<FormInput theme={s9_mockTheme} value="" onChange={onChange} />);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveStyle({ borderColor: s9_mockTheme.colors.border });
			});
			it('should apply error border color when error is provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} error="Invalid input" />
				);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveStyle({ borderColor: s9_mockTheme.colors.error });
			});
			it('should apply monospace font when monospace is true', () => {
				const onChange = vi.fn();
				s9_render(<FormInput theme={s9_mockTheme} value="" onChange={onChange} monospace={true} />);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveClass('font-mono');
			});
			it('should apply custom className when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} className="custom-class" />
				);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveClass('custom-class');
			});
			it('should apply custom height class when provided', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} heightClass="h-16" />
				);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveClass('h-16');
			});
			it('should apply label styling correctly', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} label="Test Label" />
				);
				const label = s9_screen.getByText('Test Label');
				expect(label).toHaveClass('uppercase', 'font-bold', 'text-xs');
				expect(label).toHaveStyle({ color: s9_mockTheme.colors.textMain });
			});
			it('should apply disabled styling when disabled is true', () => {
				const onChange = vi.fn();
				s9_render(<FormInput theme={s9_mockTheme} value="" onChange={onChange} disabled={true} />);
				const input = s9_screen.getByRole('textbox');
				expect(input).toBeDisabled();
				expect(input).toHaveClass('opacity-50', 'cursor-not-allowed');
			});
		});
		describe('interactions', () => {
			it('should call onChange when value changes', () => {
				const onChange = vi.fn();
				s9_render(<FormInput theme={s9_mockTheme} value="" onChange={onChange} />);
				const input = s9_screen.getByRole('textbox');
				s9_fireEvent.change(input, { target: { value: 'new value' } });
				expect(onChange).toHaveBeenCalledWith('new value');
			});
			it('should call onSubmit when Enter is pressed', () => {
				const onChange = vi.fn();
				const onSubmit = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="test" onChange={onChange} onSubmit={onSubmit} />
				);
				const input = s9_screen.getByRole('textbox');
				s9_fireEvent.keyDown(input, { key: 'Enter' });
				expect(onSubmit).toHaveBeenCalledTimes(1);
			});
			it('should NOT call onSubmit when submitEnabled is false', () => {
				const onChange = vi.fn();
				const onSubmit = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value="test"
						onChange={onChange}
						onSubmit={onSubmit}
						submitEnabled={false}
					/>
				);
				const input = s9_screen.getByRole('textbox');
				s9_fireEvent.keyDown(input, { key: 'Enter' });
				expect(onSubmit).not.toHaveBeenCalled();
			});
			it('should call custom onKeyDown before Enter handling', () => {
				const onChange = vi.fn();
				const onSubmit = vi.fn();
				const onKeyDown = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value="test"
						onChange={onChange}
						onSubmit={onSubmit}
						onKeyDown={onKeyDown}
					/>
				);
				const input = s9_screen.getByRole('textbox');
				s9_fireEvent.keyDown(input, { key: 'Enter' });
				expect(onKeyDown).toHaveBeenCalledTimes(1);
				expect(onSubmit).toHaveBeenCalledTimes(1);
			});
			it('should NOT call onSubmit if custom onKeyDown prevents default', () => {
				const onChange = vi.fn();
				const onSubmit = vi.fn();
				const onKeyDown = vi.fn((e) => e.preventDefault());
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value="test"
						onChange={onChange}
						onSubmit={onSubmit}
						onKeyDown={onKeyDown}
					/>
				);
				const input = s9_screen.getByRole('textbox');
				s9_fireEvent.keyDown(input, { key: 'Enter' });
				expect(onKeyDown).toHaveBeenCalledTimes(1);
				expect(onSubmit).not.toHaveBeenCalled();
			});
			it('should NOT call onSubmit for non-Enter keys', () => {
				const onChange = vi.fn();
				const onSubmit = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="test" onChange={onChange} onSubmit={onSubmit} />
				);
				const input = s9_screen.getByRole('textbox');
				s9_fireEvent.keyDown(input, { key: 'Escape' });
				s9_fireEvent.keyDown(input, { key: 'Tab' });
				s9_fireEvent.keyDown(input, { key: 'a' });
				expect(onSubmit).not.toHaveBeenCalled();
			});
		});
		describe('focus management', () => {
			it('should forward ref to input element', () => {
				const onChange = vi.fn();
				const ref = React.createRef<HTMLInputElement>();
				s9_render(<FormInput ref={ref} theme={s9_mockTheme} value="" onChange={onChange} />);
				expect(ref.current).toBeInstanceOf(HTMLInputElement);
				expect(ref.current).toBe(s9_screen.getByRole('textbox'));
			});
			it('should select text on focus when selectOnFocus is true', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value="select me"
						onChange={onChange}
						selectOnFocus={true}
					/>
				);
				const input = s9_screen.getByRole('textbox') as HTMLInputElement;
				// Mock the select method
				const selectMock = vi.fn();
				input.select = selectMock;
				s9_fireEvent.focus(input);
				expect(selectMock).toHaveBeenCalledTimes(1);
			});
			it('should NOT select text on focus when selectOnFocus is false', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value="don't select"
						onChange={onChange}
						selectOnFocus={false}
					/>
				);
				const input = s9_screen.getByRole('textbox') as HTMLInputElement;
				const selectMock = vi.fn();
				input.select = selectMock;
				s9_fireEvent.focus(input);
				expect(selectMock).not.toHaveBeenCalled();
			});
		});
		describe('input types', () => {
			it('should support password type', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="secret" onChange={onChange} type="password" />
				);
				const input = s9_screen.getByDisplayValue('secret');
				expect(input).toHaveAttribute('type', 'password');
			});
			it('should support email type', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value="test@example.com"
						onChange={onChange}
						type="email"
					/>
				);
				const input = s9_screen.getByDisplayValue('test@example.com');
				expect(input).toHaveAttribute('type', 'email');
			});
			it('should default to text type', () => {
				const onChange = vi.fn();
				s9_render(<FormInput theme={s9_mockTheme} value="" onChange={onChange} />);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveAttribute('type', 'text');
			});
		});
		describe('accessibility', () => {
			it('should associate label with input via htmlFor', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} label="Email Address" />
				);
				const label = s9_screen.getByText('Email Address');
				const input = s9_screen.getByLabelText('Email Address');
				expect(label).toHaveAttribute('for', input.id);
			});
			it('should generate unique id if not provided', () => {
				const onChange = vi.fn();
				const { rerender } = s9_render(
					<FormInput theme={s9_mockTheme} value="" onChange={onChange} label="First" />
				);
				const firstInput = s9_screen.getByLabelText('First');
				const firstId = firstInput.id;
				expect(firstId).toBeTruthy();
				expect(firstId).toContain(':');
				// Render a second one
				rerender(
					<>
						<FormInput theme={s9_mockTheme} value="" onChange={onChange} label="First" />
						<FormInput theme={s9_mockTheme} value="" onChange={onChange} label="Second" />
					</>
				);
				// Both should have unique IDs
				const inputs = s9_screen.getAllByRole('textbox');
				expect(inputs[0].id).toBeTruthy();
				expect(inputs[1].id).toBeTruthy();
				expect(inputs[0].id).not.toBe(inputs[1].id);
			});
		});
		describe('layout with addon', () => {
			it('should render input and addon in flex container', () => {
				const onChange = vi.fn();
				const { container } = s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						addon={<button>Icon</button>}
					/>
				);
				const flexContainer = container.querySelector('.flex.gap-2');
				expect(flexContainer).toBeInTheDocument();
			});
			it('should apply flex-1 to input when addon is present', () => {
				const onChange = vi.fn();
				s9_render(
					<FormInput
						theme={s9_mockTheme}
						value=""
						onChange={onChange}
						addon={<button>Icon</button>}
					/>
				);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveClass('flex-1');
			});
			it('should apply w-full to input when no addon', () => {
				const onChange = vi.fn();
				s9_render(<FormInput theme={s9_mockTheme} value="" onChange={onChange} />);
				const input = s9_screen.getByRole('textbox');
				expect(input).toHaveClass('w-full');
			});
		});
	});
});
// Source: src/__tests__/renderer/components/ui/SegmentedControl.test.tsx
describe('', () => {
	type Mode = 'name' | 'created' | 'queries';
	const OPTIONS = [
		{ value: 'name' as Mode, label: 'Name' },
		{ value: 'created' as Mode, label: 'Created' },
		{ value: 'queries' as Mode, label: 'Queries', title: 'Most queries first' },
	];
	const renderControl = (value: Mode, onChange = vi.fn()) => {
		s10_render(
			<SegmentedControl
				value={value}
				onChange={onChange}
				options={OPTIONS}
				theme={s10_mockTheme}
				ariaLabel="Sort agents"
				testId="sort"
			/>
		);
		return onChange;
	};
	describe('SegmentedControl', () => {
		it('marks only the chosen segment for the bar to scroll into view', () => {
			renderControl('queries');
			expect(s10_screen.getByTestId('sort-queries')).toHaveAttribute('data-reveal-active', 'true');
			expect(s10_screen.getByTestId('sort-name')).not.toHaveAttribute('data-reveal-active');
			expect(s10_screen.getByTestId('sort-created')).not.toHaveAttribute('data-reveal-active');
		});
		it('renders one segment per option inside a labelled radiogroup', () => {
			renderControl('name');
			const group = s10_screen.getByRole('radiogroup', { name: 'Sort agents' });
			expect(group).toBeInTheDocument();
			expect(s10_screen.getAllByRole('radio')).toHaveLength(3);
			expect(s10_screen.getByTestId('sort-created')).toHaveTextContent('Created');
		});
		it('marks only the active segment as checked', () => {
			renderControl('created');
			expect(s10_screen.getByTestId('sort-name')).toHaveAttribute('aria-checked', 'false');
			expect(s10_screen.getByTestId('sort-created')).toHaveAttribute('aria-checked', 'true');
			expect(s10_screen.getByTestId('sort-queries')).toHaveAttribute('aria-checked', 'false');
		});
		it('reports the clicked value', () => {
			const onChange = renderControl('name');
			s10_fireEvent.click(s10_screen.getByTestId('sort-queries'));
			expect(onChange).toHaveBeenCalledWith('queries');
		});
		// One tab stop, not one per option: a five-option sort bar should cost a
		// single Tab press to skip, the way a native radio group does.
		it('keeps a single tab stop that follows the selection', () => {
			renderControl('created');
			expect(s10_screen.getByTestId('sort-name')).toHaveAttribute('tabindex', '-1');
			expect(s10_screen.getByTestId('sort-created')).toHaveAttribute('tabindex', '0');
			expect(s10_screen.getByTestId('sort-queries')).toHaveAttribute('tabindex', '-1');
		});
		it('moves the selection with the arrow keys', () => {
			const onChange = renderControl('created');
			const group = s10_screen.getByRole('radiogroup', { name: 'Sort agents' });
			s10_fireEvent.keyDown(group, { key: 'ArrowRight' });
			expect(onChange).toHaveBeenCalledWith('queries');
			s10_fireEvent.keyDown(group, { key: 'ArrowLeft' });
			expect(onChange).toHaveBeenCalledWith('name');
		});
		it('wraps around at both ends', () => {
			const onChange = renderControl('name');
			const group = s10_screen.getByRole('radiogroup', { name: 'Sort agents' });
			s10_fireEvent.keyDown(group, { key: 'ArrowLeft' });
			expect(onChange).toHaveBeenCalledWith('queries');
		});
		it('ignores keys it does not own so the host can still use them', () => {
			const onChange = renderControl('name');
			const group = s10_screen.getByRole('radiogroup', { name: 'Sort agents' });
			s10_fireEvent.keyDown(group, { key: 'ArrowUp' });
			s10_fireEvent.keyDown(group, { key: 'Escape' });
			s10_fireEvent.keyDown(group, { key: 'a' });
			expect(onChange).not.toHaveBeenCalled();
		});
		// A bar wider than its row used to lose its last segments outright:
		// `overflow-hidden` clipped them, so they were invisible AND unclickable
		// with no scrollbar to hint they were there. On a phone the five-way sort
		// bar lost two options.
		it('scrolls sideways rather than clipping the segments it cannot fit', () => {
			renderControl('name');
			const group = s10_screen.getByRole('radiogroup');
			expect(group).toHaveClass('overflow-x-auto', 'overflow-y-hidden', 'max-w-full', 'min-w-0');
			expect(group).not.toHaveClass('overflow-hidden');
			// Every segment keeps its width inside that scroller - a squeezed
			// segment reads as a different label, not a narrower one.
			expect(s10_screen.getByTestId('sort-name')).toHaveClass('shrink-0');
		});
		it('surfaces the optional per-segment tooltip', () => {
			renderControl('name');
			expect(s10_screen.getByTestId('sort-queries')).toHaveAttribute('title', 'Most queries first');
			expect(s10_screen.getByTestId('sort-name')).not.toHaveAttribute('title');
		});
		// The host's container query picks which form is visible, so both must be
		// in the DOM with the short one hidden by default.
		it('renders both label forms when a short label is given', () => {
			s10_render(
				<SegmentedControl
					value="name"
					onChange={vi.fn()}
					options={[{ value: 'name', label: 'Full Name', shortLabel: 'Name' }]}
					theme={s10_mockTheme}
					ariaLabel="Sort agents"
					testId="sort"
				/>
			);
			expect(s10_screen.getByText('Full Name')).toHaveClass('segmented-label-full');
			expect(s10_screen.getByText('Name')).toHaveClass('segmented-label-short', 'hidden');
		});
		it('renders a plain label when no short label is given', () => {
			renderControl('name');
			expect(s10_screen.getByTestId('sort-name').querySelector('.segmented-label-full')).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/components/ui/MiniBadge.test.tsx
describe('', () => {
	function renderBadge(props: Partial<React.ComponentProps<typeof MiniBadge>> = {}) {
		const { container } = s11_render(
			<MiniBadge label="Snoozed" theme={s11_mockTheme} {...props} />
		);
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
