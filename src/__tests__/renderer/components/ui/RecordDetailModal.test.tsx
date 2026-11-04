import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { RecordDetailModal } from '../../../../renderer/components/ui/RecordDetailModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import { mockTheme } from '../../../helpers/mockTheme';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

/**
 * The shared record view, tested at the seam the CSV suite cannot see.
 *
 * `CsvTableRenderer.test.tsx` already drives the body of this component through
 * the CSV adapter - filtering, row stepping, the keyboard model. What that
 * suite cannot cover is the part that made it shared in the first place: a
 * second caller supplying its own field mapping, test ids, and modal priority.
 * Those props are what stop the parquet viewer and the CSV table from fighting
 * over one hard-coded identity, so they get their own assertions here.
 */

const FIELDS = [
	{ key: 'id', value: '42' },
	{ key: 'region', value: 'eu' },
	{ key: 'notes', value: 'line one\nline two' },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof RecordDetailModal>> = {}) {
	return render(
		<LayerStackProvider>
			<RecordDetailModal
				fields={FIELDS}
				index={0}
				total={3}
				onNavigate={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
				priority={MODAL_PRIORITIES.TABLE_ROW_DETAIL}
				resizeKey="test-record-detail"
				testIdPrefix="test-record"
				{...overrides}
			/>
		</LayerStackProvider>
	);
}

describe('RecordDetailModal', () => {
	it('renders the caller-supplied fields rather than deriving them itself', () => {
		renderModal();

		expect(screen.getByText('id')).toBeInTheDocument();
		expect(screen.getByText('region')).toBeInTheDocument();
		expect(screen.getByText('42')).toBeInTheDocument();
		expect(screen.getByText('eu')).toBeInTheDocument();
	});

	it('namespaces every test id under the caller prefix', () => {
		// The whole point of the prefix: two surfaces can have a record modal
		// open in the same app without a test targeting "whichever one is up".
		renderModal();

		expect(screen.getByTestId('test-record-modal')).toBeInTheDocument();
		expect(screen.getByTestId('test-record-search')).toBeInTheDocument();
		expect(screen.getByTestId('test-record-fields')).toBeInTheDocument();
		expect(screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();
	});

	it('shows the position within the rows the table is currently displaying', () => {
		renderModal({ index: 1, total: 3 });

		expect(screen.getByText('Row 2')).toBeInTheDocument();
		expect(screen.getByText(/of 3/)).toBeInTheDocument();
	});

	it('filters on both field names and values', () => {
		renderModal();

		fireEvent.change(screen.getByTestId('test-record-search'), { target: { value: 'region' } });
		expect(screen.getByText('region')).toBeInTheDocument();
		expect(screen.queryByText('42')).not.toBeInTheDocument();

		// Matching a VALUE keeps its field visible too - a record view is read by
		// value at least as often as by field name.
		fireEvent.change(screen.getByTestId('test-record-search'), { target: { value: '42' } });
		expect(screen.getByText('id')).toBeInTheDocument();
		expect(screen.queryByText('eu')).not.toBeInTheDocument();
	});

	it('steps rows with Left and Right without closing', () => {
		const onNavigate = vi.fn();
		const onClose = vi.fn();
		renderModal({ index: 1, total: 3, onNavigate, onClose });

		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowRight' });
		expect(onNavigate).toHaveBeenCalledWith(2);

		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowLeft' });
		expect(onNavigate).toHaveBeenCalledWith(0);

		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not step past either end of the displayed rows', () => {
		const onNavigate = vi.fn();
		const { unmount } = renderModal({ index: 0, total: 3, onNavigate });
		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowLeft' });
		expect(onNavigate).not.toHaveBeenCalled();
		unmount();

		renderModal({ index: 2, total: 3, onNavigate });
		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowRight' });
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it('renders an empty value as a placeholder instead of a blank row', () => {
		renderModal({ fields: [{ key: 'notes', value: '' }] });

		expect(screen.getByText('notes')).toBeInTheDocument();
		expect(screen.getByText('empty')).toBeInTheDocument();
	});
});
