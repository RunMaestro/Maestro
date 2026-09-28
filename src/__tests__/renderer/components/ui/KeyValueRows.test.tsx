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

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	KeyValueRows,
	keyValueRowsToRecords,
	recordToKeyValueRows,
	type KeyValueRow,
} from '../../../../renderer/components/ui/KeyValueRows';
import { mockTheme } from '../../../helpers/mockTheme';

const ROWS: KeyValueRow[] = [
	{ id: 0, key: 'ConnectTimeout', value: '45', enabled: true },
	{ id: 1, key: 'ProxyCommand', value: 'cloudflared access ssh --hostname %h', enabled: true },
];

function renderRows(props: Partial<React.ComponentProps<typeof KeyValueRows>> = {}) {
	const onChangeRow = vi.fn();
	const onRemoveRow = vi.fn();
	const onAddRow = vi.fn();
	const utils = render(
		<KeyValueRows
			theme={mockTheme}
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
		expect(screen.getByDisplayValue('ConnectTimeout')).toBeInTheDocument();
		expect(screen.getByDisplayValue('45')).toBeInTheDocument();
		expect(screen.getByDisplayValue('cloudflared access ssh --hostname %h')).toBeInTheDocument();
	});

	it('reports edits by row id and field, not by position', () => {
		const { onChangeRow } = renderRows();
		fireEvent.change(screen.getByDisplayValue('ConnectTimeout'), {
			target: { value: 'ConnectTimeoutX' },
		});
		expect(onChangeRow).toHaveBeenCalledWith(0, 'key', 'ConnectTimeoutX');

		fireEvent.change(screen.getByDisplayValue('45'), { target: { value: '60' } });
		expect(onChangeRow).toHaveBeenCalledWith(0, 'value', '60');
	});

	it('keeps the same input element across a key edit, so the caret survives', () => {
		// The regression this guards: keying the list by `row.key` gives React a
		// new key on every keystroke, remounting the input and losing focus.
		const { rerender } = renderRows();
		const before = screen.getByDisplayValue('ConnectTimeout');
		rerender(
			<KeyValueRows
				theme={mockTheme}
				label="SSH Options"
				rows={[{ ...ROWS[0], key: 'C' }, ROWS[1]]}
				onChangeRow={vi.fn()}
				onRemoveRow={vi.fn()}
				onAddRow={vi.fn()}
				addLabel="Add Option"
				testId="ssh-options"
			/>
		);
		expect(screen.getByDisplayValue('C')).toBe(before);
	});

	it('removes by row id', () => {
		const { onRemoveRow } = renderRows({ removeLabel: 'Remove option' });
		fireEvent.click(screen.getAllByRole('button', { name: 'Remove option' })[1]);
		expect(onRemoveRow).toHaveBeenCalledWith(1);
	});

	it('offers the add button even when the list is empty', () => {
		const { onAddRow } = renderRows({ rows: [] });
		fireEvent.click(screen.getByRole('button', { name: /Add Option/ }));
		expect(onAddRow).toHaveBeenCalled();
	});

	it('hides the rows when collapsed without discarding them', () => {
		// Collapsed is a display state; the caller still holds the rows, so
		// re-expanding must not have cost the user their edits.
		const { rerender } = renderRows({ collapsed: true });
		expect(screen.queryByDisplayValue('ConnectTimeout')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Add Option/ })).toBeInTheDocument();

		rerender(
			<KeyValueRows
				theme={mockTheme}
				label="SSH Options"
				rows={ROWS}
				onChangeRow={vi.fn()}
				onRemoveRow={vi.fn()}
				onAddRow={vi.fn()}
				addLabel="Add Option"
				testId="ssh-options"
			/>
		);
		expect(screen.getByDisplayValue('ConnectTimeout')).toBeInTheDocument();
	});

	describe('the parked-row eye', () => {
		it('is hidden when the caller supplies no toggle handler', () => {
			// Without somewhere to keep a parked value there is nothing the button
			// could do, so it is absent rather than rendered dead.
			renderRows();
			expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
		});

		it('reports a toggle by row id', () => {
			const onToggleRow = vi.fn();
			renderRows({ onToggleRow });
			fireEvent.click(screen.getByRole('button', { name: /Disable ProxyCommand/ }));
			expect(onToggleRow).toHaveBeenCalledWith(1);
		});

		it('offers to enable a parked row and names it in the tooltip', () => {
			const onToggleRow = vi.fn();
			renderRows({
				onToggleRow,
				rows: [{ id: 0, key: 'ProxyCommand', value: 'tailcat tcABC 22', enabled: false }],
			});
			fireEvent.click(screen.getByRole('button', { name: /Enable ProxyCommand/ }));
			expect(onToggleRow).toHaveBeenCalledWith(0);
		});

		it('keeps a parked row editable, since parking is not deleting', () => {
			const { onChangeRow } = renderRows({
				onToggleRow: vi.fn(),
				rows: [{ id: 0, key: 'ProxyCommand', value: 'tailcat tcABC 22', enabled: false }],
			});
			const input = screen.getByDisplayValue('tailcat tcABC 22');
			expect(input).not.toBeDisabled();
			fireEvent.change(input, { target: { value: 'tailcat tcXYZ 22' } });
			expect(onChangeRow).toHaveBeenCalledWith(0, 'value', 'tailcat tcXYZ 22');
		});

		it('falls back to the entry noun when the row has no key yet', () => {
			renderRows({
				onToggleRow: vi.fn(),
				entryNoun: 'option',
				rows: [{ id: 0, key: '   ', value: '', enabled: true }],
			});
			expect(screen.getByRole('button', { name: /Disable option/ })).toBeInTheDocument();
		});
	});

	it('renders the label, helper text and test id', () => {
		renderRows({ helperText: 'Passed to ssh as -o KEY=VALUE.' });
		expect(screen.getByText('SSH Options')).toBeInTheDocument();
		expect(screen.getByText('Passed to ssh as -o KEY=VALUE.')).toBeInTheDocument();
		expect(screen.getByTestId('ssh-options')).toBeInTheDocument();
	});
});
