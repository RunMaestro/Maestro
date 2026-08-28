import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { ParquetViewer } from '../../../renderer/components/ParquetViewer';
import type {
	ParquetColumnInfo,
	ParquetFileInfo,
	ParquetQueryRequest,
	ParquetQueryResult,
} from '../../../shared/parquet/types';
import { mockTheme } from '../../helpers/mockTheme';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

function column(
	name: string,
	kind: ParquetColumnInfo['kind'],
	overrides: Partial<ParquetColumnInfo> = {}
): ParquetColumnInfo {
	return {
		name,
		physicalType: 'BYTE_ARRAY',
		logicalType: null,
		kind,
		optional: true,
		nested: false,
		compression: 'SNAPPY',
		compressedBytes: 1024,
		uncompressedBytes: 4096,
		stats: { nullCount: 0, min: null, max: null, partial: false },
		...overrides,
	};
}

const INFO: ParquetFileInfo = {
	handle: 'handle-1',
	displayPath: '/data/events.parquet',
	fileBytes: 12345,
	totalRows: 1000,
	columns: [
		column('id', 'integer', { physicalType: 'INT64' }),
		column('region', 'string'),
		column('price', 'float', { physicalType: 'DOUBLE' }),
	],
	rowGroups: [{ rows: 1000, compressedBytes: 12000 }],
	createdBy: 'parquet-cpp-arrow version 14.0.1',
	formatVersion: 2,
	keyValueMetadata: [],
};

function queryResult(overrides: Partial<ParquetQueryResult> = {}): ParquetQueryResult {
	return {
		rows: [
			[1, 'us', 10.5],
			[2, 'eu', 20.5],
		],
		columns: ['id', 'region', 'price'],
		rowIndexes: [0, 1],
		matchedRows: 1000,
		complete: true,
		truncated: false,
		stats: {
			rowGroupsTotal: 1,
			rowGroupsScanned: 1,
			rowGroupsPruned: 0,
			bytesRead: 4096,
			rowsExamined: 1000,
			elapsedMs: 7,
			fullyPushedDown: true,
			columnsRead: ['id', 'region', 'price'],
		},
		...overrides,
	};
}

let open: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;

/** The last request the viewer sent, which is what most assertions here check. */
function lastRequest(): ParquetQueryRequest {
	return query.mock.calls[query.mock.calls.length - 1][0] as ParquetQueryRequest;
}

beforeEach(() => {
	installLocalStorageMock();
	vi.useFakeTimers({ shouldAdvanceTime: true });
	open = vi.fn().mockResolvedValue(INFO);
	query = vi.fn().mockResolvedValue(queryResult());
	close = vi.fn().mockResolvedValue(undefined);
	(window as unknown as { maestro: unknown }).maestro = {
		parquet: { open, query, close, export: vi.fn() },
		dialog: { saveFile: vi.fn().mockResolvedValue(null) },
	};
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function renderViewer(props: Partial<React.ComponentProps<typeof ParquetViewer>> = {}) {
	return render(
		<ParquetViewer
			filePath="/data/events.parquet"
			fileName="events.parquet"
			theme={mockTheme}
			{...props}
		/>
	);
}

/** Let the debounce fire and the queued promises settle. */
async function settle(ms = 300) {
	await act(async () => {
		vi.advanceTimersByTime(ms);
		await Promise.resolve();
	});
}

describe('ParquetViewer', () => {
	it('shows a footer-reading state before the schema arrives', async () => {
		open.mockReturnValue(new Promise(() => {}));
		renderViewer();
		expect(screen.getByText(/Reading parquet footer/)).toBeInTheDocument();
	});

	it('opens the file through the parquet IPC surface, not by reading content', async () => {
		renderViewer({ sshRemoteId: 'remote-7' });
		await waitFor(() => expect(open).toHaveBeenCalledWith('/data/events.parquet', 'remote-7'));
	});

	it('summarizes the file from its footer', async () => {
		renderViewer();
		await waitFor(() => expect(screen.getByTestId('parquet-viewer')).toBeInTheDocument());
		expect(screen.getByText(/1,000 rows, 3 columns/)).toBeInTheDocument();
		expect(screen.getByText(/parquet-cpp-arrow version 14\.0\.1/)).toBeInTheDocument();
	});

	it('reports why a file would not open rather than falling back to a blank grid', async () => {
		open.mockRejectedValue(new Error('Remote parquet file is 900 MB'));
		renderViewer();
		await waitFor(() =>
			expect(screen.getByText(/Could not open this parquet file/)).toBeInTheDocument()
		);
		expect(screen.getByText(/Remote parquet file is 900 MB/)).toBeInTheDocument();
	});

	it('requests the first page with every column projected', async () => {
		renderViewer();
		await waitFor(() => expect(query).toHaveBeenCalled());
		expect(query.mock.calls[0][0]).toMatchObject({
			handle: 'handle-1',
			filter: '',
			columns: ['id', 'region', 'price'],
			offset: 0,
		});
	});

	it('sends the filter to the engine after the debounce, not on every keystroke', async () => {
		renderViewer();
		await waitFor(() => expect(query).toHaveBeenCalled());
		const before = query.mock.calls.length;

		fireEvent.change(screen.getByTestId('parquet-filter-input'), {
			target: { value: 'region = eu' },
		});
		expect(query.mock.calls.length).toBe(before);

		await settle();
		await waitFor(() => expect(lastRequest().filter).toBe('region = eu'));
	});

	it('surfaces a filter error with its suggested column', async () => {
		query.mockResolvedValue(
			queryResult({
				rows: [],
				rowIndexes: [],
				matchedRows: 0,
				filterError: {
					message: 'No column "regionn". Did you mean "region"?',
					start: 0,
					end: 7,
					suggestion: 'region',
				},
			})
		);
		renderViewer();
		await waitFor(() => expect(screen.getByTestId('parquet-filter-error')).toBeInTheDocument());
		expect(screen.getByText(/Did you mean "region"/)).toBeInTheDocument();

		// Accepting the suggestion rewrites exactly the reported span.
		fireEvent.change(screen.getByTestId('parquet-filter-input'), {
			target: { value: 'regionn = eu' },
		});
		await settle();
		fireEvent.click(screen.getByText('Use "region"'));
		expect(screen.getByTestId('parquet-filter-input')).toHaveValue('region = eu');
	});

	it('shows the pruning readout once a filter is applied', async () => {
		query.mockResolvedValue(
			queryResult({
				stats: { ...queryResult().stats, rowGroupsTotal: 20, rowGroupsPruned: 18, bytesRead: 2048 },
			})
		);
		renderViewer();
		await waitFor(() => expect(screen.getByTestId('parquet-viewer')).toBeInTheDocument());

		fireEvent.change(screen.getByTestId('parquet-filter-input'), { target: { value: 'id > 5' } });
		await settle();

		await waitFor(() => expect(screen.getByTestId('parquet-pushdown-stats')).toBeInTheDocument());
		expect(screen.getByText(/skipped 18 of 20 row groups/)).toBeInTheDocument();
	});

	it('drops a hidden column from the projection so it is never decoded', async () => {
		renderViewer();
		await waitFor(() => expect(screen.getByTestId('parquet-schema-panel')).toBeInTheDocument());

		fireEvent.click(screen.getByTestId('parquet-column-toggle-price'));
		await waitFor(() => expect(lastRequest().columns).toEqual(['id', 'region']));
		expect(screen.getByText(/1 column\(s\) hidden from the scan/)).toBeInTheDocument();
	});

	it('asks the engine to sort when a header is clicked, and cycles asc, desc, off', async () => {
		renderViewer();
		await waitFor(() => expect(screen.getByTestId('parquet-header-price')).toBeInTheDocument());

		fireEvent.click(screen.getByTestId('parquet-header-price'));
		await waitFor(() => expect(lastRequest().sort).toEqual({ column: 'price', direction: 'asc' }));

		fireEvent.click(screen.getByTestId('parquet-header-price'));
		await waitFor(() => expect(lastRequest().sort).toEqual({ column: 'price', direction: 'desc' }));

		fireEvent.click(screen.getByTestId('parquet-header-price'));
		await waitFor(() => expect(lastRequest().sort).toBeNull());
	});

	it('marks an unfinished scan as a lower bound instead of claiming an exact total', async () => {
		query.mockResolvedValue(queryResult({ matchedRows: 42, complete: false }));
		renderViewer();
		await waitFor(() => expect(screen.getByTestId('parquet-viewer')).toBeInTheDocument());

		fireEvent.change(screen.getByTestId('parquet-filter-input'), {
			target: { value: 'region = eu' },
		});
		await settle();

		await waitFor(() => expect(screen.getByText(/42\+ of 1,000 rows match/)).toBeInTheDocument());
	});

	it('drives the count to completion in the background for a small file', async () => {
		query.mockResolvedValue(queryResult({ matchedRows: 42, complete: false }));
		renderViewer();
		await waitFor(() => expect(query).toHaveBeenCalled());
		await waitFor(() =>
			expect(query.mock.calls.some(([request]) => request.countAll === true)).toBe(true)
		);
	});

	it('warns when the match set hit the engine cap', async () => {
		query.mockResolvedValue(queryResult({ truncated: true }));
		renderViewer();
		await waitFor(() => expect(screen.getByText(/match set capped/)).toBeInTheDocument());
	});

	it('exposes a focusFilter handle so the preview can route Cmd+F to the filter box', async () => {
		const ref = React.createRef<{ focusFilter: () => void }>();
		render(
			<ParquetViewer
				ref={ref}
				filePath="/data/events.parquet"
				fileName="events.parquet"
				theme={mockTheme}
			/>
		);
		await waitFor(() => expect(screen.getByTestId('parquet-filter-input')).toBeInTheDocument());
		act(() => ref.current?.focusFilter());
		expect(document.activeElement).toBe(screen.getByTestId('parquet-filter-input'));
	});

	it('releases the main-process handle when the tab goes away', async () => {
		const { unmount } = renderViewer();
		await waitFor(() => expect(screen.getByTestId('parquet-viewer')).toBeInTheDocument());
		unmount();
		expect(close).toHaveBeenCalledWith('handle-1');
	});
});
