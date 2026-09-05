/**
 * Tests for KeyValueRows - the shared editable `key = value` list behind an SSH
 * remote's environment variables and its extra `ssh -o` options.
 *
 * The two behaviours worth locking down are the ones a reimplementation gets
 * wrong: rows are keyed by a stable `id` rather than by the editable key text
 * (keying by the text remounts the input on every keystroke and the caret jumps
 * out after one character), and `keyValueRowsToRecord` returns `undefined`
 * rather than `{}` so a section the user emptied stores no key at all.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	KeyValueRows,
	keyValueRowsToRecord,
	recordToKeyValueRows,
	type KeyValueRow,
} from '../../../../renderer/components/ui/KeyValueRows';
import { mockTheme } from '../../../helpers/mockTheme';

const ROWS: KeyValueRow[] = [
	{ id: 0, key: 'ConnectTimeout', value: '45' },
	{ id: 1, key: 'ProxyCommand', value: 'cloudflared access ssh --hostname %h' },
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

describe('keyValueRowsToRecord', () => {
	it('returns undefined rather than an empty object when nothing survives', () => {
		// A section the user emptied must store no key at all; `{}` would write
		// an empty map back into the remote config.
		expect(keyValueRowsToRecord([])).toBeUndefined();
		expect(keyValueRowsToRecord([{ id: 0, key: '   ', value: 'orphan' }])).toBeUndefined();
	});

	it('drops blank keys and trims the surviving ones', () => {
		expect(
			keyValueRowsToRecord([
				{ id: 0, key: '  ConnectTimeout  ', value: '45' },
				{ id: 1, key: '', value: 'dropped' },
			])
		).toEqual({ ConnectTimeout: '45' });
	});

	it('keeps a blank value, which is meaningful for some options', () => {
		expect(keyValueRowsToRecord([{ id: 0, key: 'ProxyCommand', value: '' }])).toEqual({
			ProxyCommand: '',
		});
	});

	it('round-trips a record unchanged', () => {
		const record = { ConnectTimeout: '45', ProxyJump: 'bastion' };
		expect(keyValueRowsToRecord(recordToKeyValueRows(record))).toEqual(record);
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

	it('renders the label, helper text and test id', () => {
		renderRows({ helperText: 'Passed to ssh as -o KEY=VALUE.' });
		expect(screen.getByText('SSH Options')).toBeInTheDocument();
		expect(screen.getByText('Passed to ssh as -o KEY=VALUE.')).toBeInTheDocument();
		expect(screen.getByTestId('ssh-options')).toBeInTheDocument();
	});
});
