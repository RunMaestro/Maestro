import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoRunPanel } from '../../../web/mobile/AutoRunPanel';

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

const hapticMock = vi.hoisted(() => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		...hapticMock,
	};
});

vi.mock('../../../web/mobile/AutoRunInline', () => ({
	AutoRunInline: ({
		sessionId,
		onOpenSetup,
		onExpandDocument,
		onSelectedDocumentChange,
		onOpenFolderPicker,
		onOpenMarketplace,
		onResumeAfterError,
		onSkipAfterError,
		onAbortAfterError,
	}: {
		sessionId: string;
		onOpenSetup?: () => void;
		onExpandDocument?: (filename: string) => void;
		onSelectedDocumentChange?: (filename: string | null) => void;
		onOpenFolderPicker?: () => void;
		onOpenMarketplace?: () => void;
		onResumeAfterError?: () => void;
		onSkipAfterError?: () => void;
		onAbortAfterError?: () => void;
	}) => (
		<div>
			<div>Inline for {sessionId}</div>
			<button type="button" onClick={onOpenSetup}>
				Open setup
			</button>
			<button type="button" onClick={() => onExpandDocument?.('phase.md')}>
				Open document
			</button>
			<button type="button" onClick={() => onSelectedDocumentChange?.('phase.md')}>
				Select document
			</button>
			<button type="button" onClick={onOpenFolderPicker}>
				Open folder picker
			</button>
			<button type="button" onClick={onOpenMarketplace}>
				Open marketplace
			</button>
			<button type="button" onClick={onResumeAfterError}>
				Resume
			</button>
			<button type="button" onClick={onSkipAfterError}>
				Skip
			</button>
			<button type="button" onClick={onAbortAfterError}>
				Abort
			</button>
			<div role="dialog" aria-label="Nested dialog">
				<button type="button">Nested focus</button>
			</div>
		</div>
	),
}));

function renderPanel(overrides: Partial<Parameters<typeof AutoRunPanel>[0]> = {}) {
	const props = {
		sessionId: 'session-1',
		autoRunState: null,
		onClose: vi.fn(),
		onOpenDocument: vi.fn(),
		onOpenSetup: vi.fn(),
		sendRequest: vi.fn(),
		send: vi.fn(),
		onResumeAfterError: vi.fn(),
		onSkipAfterError: vi.fn(),
		onAbortAfterError: vi.fn(),
		onSelectedDocumentChange: vi.fn(),
		onOpenFolderPicker: vi.fn(),
		onOpenMarketplace: vi.fn(),
		...overrides,
	};
	render(<AutoRunPanel {...props} />);
	return props;
}

describe('AutoRunPanel', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('renders Auto Run inline content and forwards wrapper actions', () => {
		const props = renderPanel();

		expect(screen.getByRole('heading', { name: 'Auto Run' })).toBeInTheDocument();
		expect(screen.getByText('Inline for session-1')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Open setup' }));
		expect(props.onOpenSetup).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
		expect(props.onOpenDocument).toHaveBeenCalledWith('phase.md');

		fireEvent.click(screen.getByRole('button', { name: 'Select document' }));
		expect(props.onSelectedDocumentChange).toHaveBeenCalledWith('phase.md');

		fireEvent.click(screen.getByRole('button', { name: 'Open folder picker' }));
		expect(props.onOpenFolderPicker).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Open marketplace' }));
		expect(props.onOpenMarketplace).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
		fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
		fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
		expect(props.onResumeAfterError).toHaveBeenCalledTimes(1);
		expect(props.onSkipAfterError).toHaveBeenCalledTimes(1);
		expect(props.onAbortAfterError).toHaveBeenCalledTimes(1);
	});

	it('closes from the header button and Escape outside nested dialogs only', () => {
		const props = renderPanel();

		fireEvent.keyDown(screen.getByRole('button', { name: 'Nested focus' }), { key: 'Escape' });
		expect(props.onClose).not.toHaveBeenCalled();

		fireEvent.keyDown(document.body, { key: 'Escape' });
		expect(props.onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Close Auto Run panel' }));
		expect(props.onClose).toHaveBeenCalledTimes(2);
		expect(hapticMock.triggerHaptic).toHaveBeenCalled();
	});
});
