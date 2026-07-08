import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoRunDocumentViewer } from '../../../web/mobile/AutoRunDocumentViewer';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		triggerHaptic: vi.fn(),
		HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
	};
});

vi.mock('../../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: ({ content }: { content: string }) => (
		<div data-testid="markdown-preview">{content}</div>
	),
}));

function renderViewer(overrides: Partial<Parameters<typeof AutoRunDocumentViewer>[0]> = {}) {
	const sendRequest = vi.fn().mockResolvedValue({ content: '# Plan\nAlpha task\nAlpha wrap' });
	const props = {
		sessionId: 'session-1',
		filename: 'plan.md',
		onBack: vi.fn(),
		sendRequest,
		...overrides,
	};
	render(<AutoRunDocumentViewer {...props} />);
	return props;
}

describe('AutoRunDocumentViewer', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(window, 'confirm').mockReturnValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads document content and renders preview mode', async () => {
		const { sendRequest } = renderViewer();

		expect(screen.getByText('Loading document...')).toBeInTheDocument();

		expect(await screen.findByTestId('markdown-preview')).toHaveTextContent(
			'# Plan Alpha task Alpha wrap'
		);
		expect(sendRequest).toHaveBeenCalledWith('get_auto_run_document', {
			sessionId: 'session-1',
			filename: 'plan.md',
		});
	});

	it('edits and saves document content', async () => {
		const sendRequest = vi
			.fn()
			.mockResolvedValueOnce({ content: 'Draft' })
			.mockResolvedValueOnce({ success: true });
		renderViewer({ sendRequest });

		await screen.findByTestId('markdown-preview');
		fireEvent.click(screen.getByRole('button', { name: 'Switch to edit' }));
		const textarea = document.querySelector('textarea')!;
		fireEvent.change(textarea, { target: { value: 'Draft\nUpdated' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save document' }));

		await waitFor(() =>
			expect(sendRequest).toHaveBeenLastCalledWith('save_auto_run_document', {
				sessionId: 'session-1',
				filename: 'plan.md',
				content: 'Draft\nUpdated',
			})
		);
		expect(await screen.findByText('Saved')).toBeInTheDocument();
	});

	it('surfaces save failures without changing the loaded content', async () => {
		const sendRequest = vi
			.fn()
			.mockResolvedValueOnce({ content: 'Original' })
			.mockResolvedValueOnce({ success: false });
		renderViewer({ sendRequest });

		await screen.findByTestId('markdown-preview');
		fireEvent.click(screen.getByRole('button', { name: 'Switch to edit' }));
		fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Broken' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save document' }));

		expect(await screen.findByText('Save failed')).toBeInTheDocument();
		expect(sendRequest).toHaveBeenLastCalledWith(
			'save_auto_run_document',
			expect.objectContaining({ content: 'Broken' })
		);
	});

	it('opens search, counts matches, and navigates between them', async () => {
		renderViewer();

		await screen.findByTestId('markdown-preview');
		fireEvent.click(screen.getByRole('button', { name: 'Search document' }));
		fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'alpha' } });

		expect(screen.getByText('1 / 2')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
		expect(screen.getByText('2 / 2')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
		expect(screen.getByText('1 / 2')).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole('button', { name: 'Close search' }).at(-1)!);
		expect(screen.queryByLabelText('Search query')).not.toBeInTheDocument();
	});

	it('confirms before discarding dirty edits on back', async () => {
		const onBack = vi.fn();
		renderViewer({ onBack });

		await screen.findByTestId('markdown-preview');
		fireEvent.click(screen.getByRole('button', { name: 'Switch to edit' }));
		fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Dirty' } });

		vi.mocked(window.confirm).mockReturnValueOnce(false);
		fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
		expect(onBack).not.toHaveBeenCalled();

		vi.mocked(window.confirm).mockReturnValueOnce(true);
		fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it('keeps locked documents read-only', async () => {
		renderViewer({ isLocked: true });

		await screen.findByTestId('markdown-preview');
		expect(screen.getByText(/locked.*Auto Run in progress/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Switch to edit' })).toBeDisabled();

		fireEvent.click(screen.getByRole('button', { name: 'Search document' }));
		fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'alpha' } });
		expect(document.querySelector('textarea')).toBeNull();
		expect(screen.getByText('1 / 2')).toBeInTheDocument();
	});

	it('renders an empty document after load failure and logs the failed request', async () => {
		const sendRequest = vi.fn().mockRejectedValue(new Error('offline'));
		renderViewer({ sendRequest });

		expect(await screen.findByText('This document is empty.')).toBeInTheDocument();
		expect(console.error).toHaveBeenCalledWith(
			'[AutoRunDocumentViewer] get_auto_run_document failed',
			expect.objectContaining({ sessionId: 'session-1', filename: 'plan.md' })
		);
	});
});
