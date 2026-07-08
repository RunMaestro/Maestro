import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ContextManagementSheet } from '../../../web/mobile/ContextManagementSheet';

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
		HAPTIC_PATTERNS: {
			tap: [10],
			send: [10, 20],
			success: [10, 30, 60],
			error: [60, 30, 10],
		},
	};
});

const sessions = [
	{ id: 'session-1', name: 'Alpha', status: 'idle', type: 'codex' },
	{ id: 'session-2', name: 'Beta', status: 'idle', type: 'claude-code' },
	{ id: 'session-3', name: 'Gamma', status: 'idle', type: 'terminal' },
];

function renderContextSheet(overrides: Partial<Parameters<typeof ContextManagementSheet>[0]> = {}) {
	const props = {
		sessions,
		currentSessionId: 'session-1',
		onClose: vi.fn(),
		sendRequest: vi.fn().mockResolvedValue({ success: true }),
		...overrides,
	};

	render(<ContextManagementSheet {...(props as any)} />);

	return props;
}

describe('ContextManagementSheet', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('merges context into a selected target session', async () => {
		const { sendRequest } = renderContextSheet();

		fireEvent.click(screen.getByRole('button', { name: /Merge/ }));
		fireEvent.click(screen.getAllByText('Beta')[1]);
		fireEvent.click(screen.getByLabelText('Execute merge'));

		await waitFor(() =>
			expect(sendRequest).toHaveBeenCalledWith(
				'merge_context',
				{ sourceSessionId: 'session-1', targetSessionId: 'session-2' },
				30000
			)
		);
		expect(await screen.findByText('Merge completed successfully')).toBeInTheDocument();
	});

	it('summarizes the current session with the longer timeout', async () => {
		const { sendRequest } = renderContextSheet();

		fireEvent.click(screen.getByRole('button', { name: /Summarize/ }));
		fireEvent.click(screen.getByLabelText('Execute summarize'));

		await waitFor(() =>
			expect(sendRequest).toHaveBeenCalledWith(
				'summarize_context',
				{ sessionId: 'session-1' },
				60000
			)
		);
		expect(await screen.findByText('Summarize completed successfully')).toBeInTheDocument();
	});

	it('shows failure and does not close on Escape while executing', async () => {
		let resolveRequest: (value: { success: boolean }) => void = () => {};
		const sendRequest = vi.fn(
			() =>
				new Promise<{ success: boolean }>((resolve) => {
					resolveRequest = resolve;
				})
		);
		const onClose = vi.fn();
		renderContextSheet({ sendRequest: sendRequest as any, onClose });

		fireEvent.click(screen.getByRole('button', { name: /Transfer/ }));
		fireEvent.click(screen.getAllByText('Beta')[1]);
		fireEvent.click(screen.getByLabelText('Execute transfer'));
		expect(screen.getByText('Executing...')).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();

		await act(async () => {
			resolveRequest({ success: false });
		});

		expect(await screen.findByText('Transfer failed')).toBeInTheDocument();
	});
});
