import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollapsibleJsonViewer } from '../../../renderer/components/CollapsibleJsonViewer';
import { safeClipboardWrite } from '../../../renderer/utils/clipboard';
import type { Theme } from '../../../renderer/types';

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn(),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const renderViewer = (
	data: unknown,
	overrides: Partial<React.ComponentProps<typeof CollapsibleJsonViewer>> = {}
) => {
	return render(<CollapsibleJsonViewer data={data} theme={testTheme} {...overrides} />);
};

const getExpandableRow = (label: string): HTMLElement => {
	const labelNode = screen.getByText(label);
	const row = labelNode.closest('.cursor-pointer');
	if (!row) {
		throw new Error(`No expandable row found for ${label}`);
	}
	return row as HTMLElement;
};

describe('CollapsibleJsonViewer', () => {
	beforeEach(() => {
		vi.mocked(safeClipboardWrite).mockResolvedValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('renders primitive values with keys and punctuation', () => {
		renderViewer(
			{
				name: 'Maestro',
				count: 3,
				enabled: true,
				missing: null,
				voidValue: undefined,
			},
			{ rootLabel: 'root' }
		);

		expect(screen.getByText('"root"')).toBeInTheDocument();
		expect(screen.getByText('"name"')).toBeInTheDocument();
		expect(screen.getByText('"Maestro"')).toHaveStyle({ color: testTheme.colors.success });
		expect(screen.getByText('3')).toHaveStyle({ color: testTheme.colors.accent });
		expect(screen.getByText('true')).toHaveStyle({ color: testTheme.colors.warning });
		expect(screen.getByText('null')).toHaveStyle({ color: testTheme.colors.warning });
		expect(screen.getByText('undefined')).toHaveStyle({ color: testTheme.colors.textDim });
	});

	it('escapes and truncates long strings', () => {
		renderViewer(
			{
				message: 'quote " slash \\ and a very long string',
			},
			{ maxStringLength: 16 }
		);

		expect(screen.getByText('"quote \\" slash \\..."')).toBeInTheDocument();
	});

	it('shows object previews when collapsed and toggles expansion', () => {
		renderViewer(
			{
				alpha: 1,
				beta: 2,
				gamma: 3,
				delta: 4,
			},
			{ rootLabel: 'payload', initialExpandLevel: 0 }
		);

		expect(screen.getByText('{ alpha, beta, gamma, ... }')).toBeInTheDocument();
		expect(screen.queryByText('"alpha"')).not.toBeInTheDocument();

		fireEvent.click(getExpandableRow('"payload"'));

		expect(screen.getByText('"alpha"')).toBeInTheDocument();
		expect(screen.queryByText('{ alpha, beta, gamma, ... }')).not.toBeInTheDocument();

		fireEvent.click(getExpandableRow('"payload"'));

		expect(screen.getByText('{ alpha, beta, gamma, ... }')).toBeInTheDocument();
	});

	it('shows compact previews for objects with three or fewer keys', () => {
		renderViewer({ one: 1, two: 2, three: 3 }, { rootLabel: 'small', initialExpandLevel: 0 });

		expect(screen.getByText('{ one, two, three }')).toBeInTheDocument();
	});

	it('shows array previews and renders array items without key labels', () => {
		renderViewer(['first', 2, false], { rootLabel: 'items', initialExpandLevel: 0 });

		expect(screen.getByText('Array(3)')).toBeInTheDocument();

		fireEvent.click(getExpandableRow('"items"'));

		expect(screen.getByText('"first"')).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('false')).toBeInTheDocument();
		expect(screen.queryByText('"0"')).not.toBeInTheDocument();
	});

	it('renders comma punctuation after non-last object siblings when collapsed and expanded', () => {
		const data = {
			first: { one: 1 },
			second: { two: 2 },
		};

		const { container, unmount } = renderViewer(data, {
			rootLabel: 'root',
			initialExpandLevel: 1,
		});

		expect(container.textContent).toContain('"first": {{ one }},');
		unmount();

		const { container: expandedContainer } = renderViewer(data, {
			rootLabel: 'root',
			initialExpandLevel: 3,
		});

		expect(expandedContainer.textContent).toContain('},"second"');
	});

	it('renders empty objects and arrays with immediate closing brackets', () => {
		renderViewer(
			{
				emptyObject: {},
				emptyArray: [],
			},
			{ initialExpandLevel: 3 }
		);

		expect(screen.getByText('"emptyObject"')).toBeInTheDocument();
		expect(screen.getByText('"emptyArray"')).toBeInTheDocument();
		expect(screen.getAllByText('}').length).toBeGreaterThan(0);
		expect(screen.getAllByText(']').length).toBeGreaterThan(0);
	});

	it('renders primitive root values without a key label', () => {
		renderViewer('root-value');

		expect(screen.getByText('"root-value"')).toBeInTheDocument();
		expect(screen.queryByText(/:/)).not.toBeInTheDocument();
	});

	it('renders non-json primitive values through their string representation', () => {
		const fn = function sampleFunction() {
			return 'sample';
		};

		renderViewer({ fn });

		expect(screen.getByText(/function sampleFunction/)).toBeInTheDocument();
		expect(screen.getByText(/return ["']sample["']/)).toBeInTheDocument();
	});

	it('copies string values directly and resets copy feedback', async () => {
		const originalSetTimeout = globalThis.setTimeout;
		let resetCopyFeedback: (() => void) | undefined;
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout) => {
			if (timeout === 1500 && typeof handler === 'function') {
				resetCopyFeedback = handler as () => void;
				return 0 as ReturnType<typeof setTimeout>;
			}
			return originalSetTimeout(handler, timeout);
		});
		renderViewer({ name: 'Maestro' });

		fireEvent.click(screen.getAllByTitle('Copy value')[1]);

		await waitFor(() => {
			expect(safeClipboardWrite).toHaveBeenCalledWith('Maestro');
		});

		expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1500);
		await waitFor(() => expect(screen.getByTestId('check-icon')).toBeInTheDocument());
		act(() => {
			resetCopyFeedback?.();
		});
		expect(screen.queryByTestId('check-icon')).not.toBeInTheDocument();
		expect(safeClipboardWrite).toHaveBeenCalledTimes(1);
		timeoutSpy.mockRestore();
	});

	it('copies objects as formatted JSON and keeps event propagation from toggling', async () => {
		renderViewer({ nested: { ok: true } }, { rootLabel: 'payload', initialExpandLevel: 0 });

		fireEvent.click(screen.getByTitle('Copy value'));

		await waitFor(() => {
			expect(safeClipboardWrite).toHaveBeenCalledWith(
				JSON.stringify({ nested: { ok: true } }, null, 2)
			);
		});
		expect(screen.getByText('{ nested }')).toBeInTheDocument();
	});

	it('does not show copy feedback when clipboard writing fails', async () => {
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		vi.mocked(safeClipboardWrite).mockResolvedValue(false);
		renderViewer({ name: 'Maestro' });

		fireEvent.click(screen.getAllByTitle('Copy value')[1]);

		await waitFor(() => {
			expect(safeClipboardWrite).toHaveBeenCalledWith('Maestro');
		});

		expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 1500);
		timeoutSpy.mockRestore();
	});
});
