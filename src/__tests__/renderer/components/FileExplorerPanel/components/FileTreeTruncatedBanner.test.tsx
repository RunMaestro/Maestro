import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeTruncatedBanner } from '../../../../../renderer/components/FileExplorerPanel/components/FileTreeTruncatedBanner';

const theme = {
	colors: { warning: '#F59E0B', textMain: '#fff', textDim: '#888', border: '#333', bgMain: '#111' },
} as any;

describe('FileTreeTruncatedBanner', () => {
	it('displays the cap label when previousCap is provided', () => {
		render(
			<FileTreeTruncatedBanner
				theme={theme}
				previousCap={100000}
				onLoadMore={vi.fn()}
				onLoadAll={vi.fn()}
				isRefreshing={false}
				onCollapse={vi.fn()}
			/>
		);
		expect(screen.getByText(/100,000/)).toBeTruthy();
	});

	it('shows "the configured cap" when previousCap is undefined', () => {
		render(
			<FileTreeTruncatedBanner
				theme={theme}
				onLoadMore={vi.fn()}
				onLoadAll={vi.fn()}
				isRefreshing={false}
				onCollapse={vi.fn()}
			/>
		);
		expect(screen.getByText(/the configured cap/)).toBeTruthy();
	});

	it('displays the doubled cap in the Load more button', () => {
		render(
			<FileTreeTruncatedBanner
				theme={theme}
				previousCap={50000}
				onLoadMore={vi.fn()}
				onLoadAll={vi.fn()}
				isRefreshing={false}
				onCollapse={vi.fn()}
			/>
		);
		expect(screen.getByText(/Load more \(100,000\)/)).toBeTruthy();
	});

	it('calls onLoadMore when Load more is clicked', () => {
		const onLoadMore = vi.fn();
		render(
			<FileTreeTruncatedBanner
				theme={theme}
				previousCap={100000}
				onLoadMore={onLoadMore}
				onLoadAll={vi.fn()}
				isRefreshing={false}
				onCollapse={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByText(/Load more/));
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it('calls onLoadAll when Load all is clicked', () => {
		const onLoadAll = vi.fn();
		render(
			<FileTreeTruncatedBanner
				theme={theme}
				previousCap={100000}
				onLoadMore={vi.fn()}
				onLoadAll={onLoadAll}
				isRefreshing={false}
				onCollapse={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByText('Load all'));
		expect(onLoadAll).toHaveBeenCalledTimes(1);
	});

	it('calls onCollapse when the minimize button is clicked', () => {
		const onCollapse = vi.fn();
		render(
			<FileTreeTruncatedBanner
				theme={theme}
				previousCap={100000}
				onLoadMore={vi.fn()}
				onLoadAll={vi.fn()}
				isRefreshing={false}
				onCollapse={onCollapse}
			/>
		);
		fireEvent.click(screen.getByLabelText('Minimize file scan warning'));
		expect(onCollapse).toHaveBeenCalledTimes(1);
	});

	it('disables buttons while refreshing', () => {
		render(
			<FileTreeTruncatedBanner
				theme={theme}
				previousCap={100000}
				onLoadMore={vi.fn()}
				onLoadAll={vi.fn()}
				isRefreshing={true}
				onCollapse={vi.fn()}
			/>
		);
		expect((screen.getByText(/Load more/) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByText('Load all') as HTMLButtonElement).disabled).toBe(true);
	});
});
