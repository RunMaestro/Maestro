import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWarningSash } from '../../renderer/components/ContextWarningSash';
import type { Theme } from '../../renderer/types';

const baseTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1f1f1f',
		bgActivity: '#2b2b2b',
		textMain: '#f5f5f5',
		textDim: '#a3a3a3',
		accent: '#38bdf8',
		border: '#404040',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		syntaxComment: '#737373',
		syntaxKeyword: '#c084fc',
	},
};

function renderSash(
	props: Partial<React.ComponentProps<typeof ContextWarningSash>> = {},
	onSummarizeClick = vi.fn()
) {
	return {
		onSummarizeClick,
		...render(
			<ContextWarningSash
				theme={baseTheme}
				contextUsage={65}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={onSummarizeClick}
				{...props}
			/>
		),
	};
}

describe('ContextWarningSash integration', () => {
	afterEach(() => {
		cleanup();
	});

	it('does not render when disabled or below warning thresholds', () => {
		renderSash({ enabled: false });
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();

		cleanup();
		renderSash({ contextUsage: 50 });
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('renders yellow and red warnings across dark and light themes', () => {
		const { rerender } = renderSash();

		expect(
			screen.getByRole('alert', { name: 'Context window at 65% capacity' })
		).toBeInTheDocument();
		expect(screen.getByText(/reaching/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Dismiss warning' }).style.color).toBe(
			'rgb(253, 224, 71)'
		);

		rerender(
			<ContextWarningSash
				theme={{ ...baseTheme, mode: 'light' }}
				contextUsage={65}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
			/>
		);
		expect(screen.getByRole('button', { name: 'Dismiss warning' }).style.color).toBe(
			'rgb(133, 77, 14)'
		);

		rerender(
			<ContextWarningSash
				theme={baseTheme}
				contextUsage={85}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
			/>
		);
		expect(screen.getByText(/consider compacting/)).toBeInTheDocument();
		expect(document.querySelector('.warning-icon-pulse')).toBeInTheDocument();

		rerender(
			<ContextWarningSash
				theme={{ ...baseTheme, mode: 'light' }}
				contextUsage={85}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
			/>
		);
		expect(screen.getByRole('button', { name: 'Dismiss warning' }).style.color).toBe(
			'rgb(153, 27, 27)'
		);
	});

	it('calls summarize and dismiss handlers from click and Enter key interactions', () => {
		const onSummarizeClick = vi.fn();
		renderSash({}, onSummarizeClick);

		const compact = screen.getByRole('button', { name: 'Compact & Continue' });
		fireEvent.keyDown(compact, { key: 'Tab' });
		fireEvent.keyDown(compact, { key: 'Enter' });
		fireEvent.click(compact);
		expect(onSummarizeClick).toHaveBeenCalledTimes(2);

		const dismiss = screen.getByRole('button', { name: 'Dismiss warning' });
		fireEvent.keyDown(dismiss, { key: 'Tab' });
		fireEvent.keyDown(dismiss, { key: 'Enter' });
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('hides dismissed warnings until usage increases or severity crosses to red', () => {
		const { rerender } = renderSash({ contextUsage: 65, tabId: 'tab-a' });

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();

		rerender(
			<ContextWarningSash
				theme={baseTheme}
				contextUsage={74}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
				tabId="tab-a"
			/>
		);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();

		rerender(
			<ContextWarningSash
				theme={baseTheme}
				contextUsage={75}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
				tabId="tab-a"
			/>
		);
		expect(screen.getByRole('alert')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
		rerender(
			<ContextWarningSash
				theme={baseTheme}
				contextUsage={79}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
				tabId="tab-a"
			/>
		);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();

		rerender(
			<ContextWarningSash
				theme={baseTheme}
				contextUsage={80}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
				tabId="tab-a"
			/>
		);
		expect(screen.getByRole('alert')).toBeInTheDocument();

		rerender(
			<ContextWarningSash
				theme={baseTheme}
				contextUsage={65}
				yellowThreshold={60}
				redThreshold={80}
				enabled
				onSummarizeClick={vi.fn()}
				tabId="tab-b"
			/>
		);
		expect(screen.getByRole('alert')).toBeInTheDocument();
	});
});
