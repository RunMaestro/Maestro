import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonlViewer } from '../../../renderer/components/JsonlViewer';
import { safeClipboardWrite } from '../../../renderer/utils/clipboard';
import type { Theme } from '../../../renderer/types';
import { THEMES } from '../../../shared/themes';

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn(),
}));

const theme = THEMES.dracula as Theme;

const jsonl = [
	JSON.stringify({ level: 'info', msg: 'alpha', count: 2, nested: { ok: true } }),
	JSON.stringify({ level: 'error', msg: 'failed request', count: 10, nested: { ok: false } }),
	'{bad json',
	JSON.stringify({ level: 'warn', msg: 'beta', count: 1, nested: { ok: true } }),
].join('\n');

describe('JsonlViewer', () => {
	beforeEach(() => {
		vi.mocked(safeClipboardWrite).mockResolvedValue(true);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('auto-detects tabular JSONL, reports parse errors, expands rows, and sorts columns', () => {
		render(<JsonlViewer content={jsonl} theme={theme} />);

		expect(screen.getByText(/4 lines/)).toBeInTheDocument();
		expect(screen.getByText(/1 parse error/)).toBeInTheDocument();
		expect(screen.getByText(/4 columns/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /table/i })).toBeEnabled();

		const table = screen.getByRole('table');
		expect(within(table).getByText('level')).toBeInTheDocument();
		expect(within(table).getByText('msg')).toBeInTheDocument();
		expect(within(table).getByText('count')).toBeInTheDocument();

		const alpha = screen.getByText('alpha');
		const failed = screen.getByText('failed request');
		const beta = screen.getByText('beta');
		expect(alpha.compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.click(screen.getByText('count'));
		expect(beta.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.click(screen.getByText('count'));
		expect(failed.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.click(screen.getByText('failed request'));
		expect(screen.getByText('"failed request"')).toBeInTheDocument();
	});

	it('switches to tree mode, expands rows, copies a displayed line, and handles empty files', async () => {
		render(<JsonlViewer content={jsonl} theme={theme} />);

		fireEvent.click(screen.getByRole('button', { name: /tree/i }));
		fireEvent.click(screen.getByRole('button', { name: /expand/i }));

		expect(screen.getByText('"alpha"')).toBeInTheDocument();
		expect(screen.getByText(/Parse error:/)).toBeInTheDocument();

		fireEvent.click(screen.getAllByTitle('Copy line')[0]);
		expect(safeClipboardWrite).toHaveBeenCalledWith(
			JSON.stringify({ level: 'info', msg: 'alpha', count: 2, nested: { ok: true } }, null, 2)
		);

		cleanup();
		render(<JsonlViewer content="" theme={theme} />);
		expect(screen.getByText('Empty JSONL file')).toBeInTheDocument();
	});

	it('applies search and jq filters, reports match counts, and surfaces jq errors', async () => {
		vi.useFakeTimers();
		const onMatchCount = vi.fn();
		const onJqError = vi.fn();
		const { rerender } = render(
			<JsonlViewer
				content={jsonl}
				theme={theme}
				searchQuery="fail"
				jqFilter='select(.level == "error")'
				onMatchCount={onMatchCount}
				onJqError={onJqError}
			/>
		);

		expect(screen.getByText(/1 of 4 lines/)).toBeInTheDocument();
		expect(screen.getByText('failed request')).toBeInTheDocument();
		expect(onMatchCount).toHaveBeenLastCalledWith(1);
		expect(onJqError).toHaveBeenLastCalledWith(null);

		rerender(
			<JsonlViewer
				content={jsonl}
				theme={theme}
				searchQuery="missing"
				jqFilter='select(.level == "error")'
				onMatchCount={onMatchCount}
				onJqError={onJqError}
			/>
		);
		expect(screen.getByText('No lines match filter')).toBeInTheDocument();
		expect(onMatchCount).toHaveBeenLastCalledWith(0);

		rerender(
			<JsonlViewer
				content={jsonl}
				theme={theme}
				jqFilter="select("
				onMatchCount={onMatchCount}
				onJqError={onJqError}
			/>
		);

		await act(async () => {
			vi.advanceTimersByTime(250);
		});

		expect(onJqError).toHaveBeenLastCalledWith(expect.stringContaining('Unexpected'));
	});

	it('parses a single JSON document in json mode and disables table view for arrays', () => {
		render(
			<JsonlViewer
				content={JSON.stringify([{ id: 1 }, { id: 2 }])}
				theme={theme}
				parseMode="json"
			/>
		);

		expect(screen.getByText('1 lines')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /table/i })).toBeDisabled();
		expect(screen.getByRole('button', { name: /tree/i })).toBeEnabled();
	});
});
