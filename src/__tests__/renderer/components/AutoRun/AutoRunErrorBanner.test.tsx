import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
	AutoRunErrorBanner,
	AutoRunErrorBannerProps,
} from '../../../../renderer/components/AutoRun/AutoRunErrorBanner';

const createMockTheme = () => ({
	id: 'test',
	name: 'Test',
	mode: 'dark' as const,
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		textMain: '#fff',
		textDim: '#888',
		accent: '#0066ff',
		accentForeground: '#fff',
		border: '#333',
		highlight: '#0066ff33',
		success: '#0a0',
		warning: '#fa0',
		error: '#f00',
	},
});

const defaultProps: AutoRunErrorBannerProps = {
	theme: createMockTheme() as any,
	errorMessage: 'Something went wrong',
	isRecoverable: false,
};

function renderBanner(overrides: Partial<AutoRunErrorBannerProps> = {}) {
	return render(<AutoRunErrorBanner {...defaultProps} {...overrides} />);
}

describe('AutoRunErrorBanner', () => {
	it('renders "Auto Run Paused" heading', () => {
		renderBanner();
		expect(screen.getByText('Auto Run Paused')).toBeInTheDocument();
	});

	it('displays the error message', () => {
		renderBanner({ errorMessage: 'File not found' });
		expect(screen.getByText('File not found')).toBeInTheDocument();
	});

	it('shows document name when errorDocumentName is provided', () => {
		renderBanner({ errorDocumentName: 'readme.md' });
		expect(screen.getByText('readme.md')).toBeInTheDocument();
		expect(screen.getByText(/while processing/)).toBeInTheDocument();
	});

	it('hides document name when errorDocumentName is not provided', () => {
		renderBanner();
		expect(screen.queryByText(/while processing/)).not.toBeInTheDocument();
	});

	it('shows Resume button when isRecoverable=true AND onResumeAfterError provided', () => {
		renderBanner({ isRecoverable: true, onResumeAfterError: vi.fn() });
		expect(screen.getByText('Resume')).toBeInTheDocument();
	});

	it('hides Resume button when isRecoverable=false', () => {
		renderBanner({ isRecoverable: false, onResumeAfterError: vi.fn() });
		expect(screen.queryByText('Resume')).not.toBeInTheDocument();
	});

	it('hides Resume button when onResumeAfterError is not provided even if recoverable', () => {
		renderBanner({ isRecoverable: true });
		expect(screen.queryByText('Resume')).not.toBeInTheDocument();
	});

	it('shows Abort Run button when onAbortBatchOnError is provided', () => {
		renderBanner({ onAbortBatchOnError: vi.fn() });
		expect(screen.getByText('Abort Run')).toBeInTheDocument();
	});

	it('hides Abort Run button when onAbortBatchOnError is not provided', () => {
		renderBanner();
		expect(screen.queryByText('Abort Run')).not.toBeInTheDocument();
	});

	it('clicking Resume calls onResumeAfterError', () => {
		const onResume = vi.fn();
		renderBanner({ isRecoverable: true, onResumeAfterError: onResume });
		fireEvent.click(screen.getByText('Resume'));
		expect(onResume).toHaveBeenCalledTimes(1);
	});

	it('clicking Abort calls onAbortBatchOnError', () => {
		const onAbort = vi.fn();
		renderBanner({ onAbortBatchOnError: onAbort });
		fireEvent.click(screen.getByText('Abort Run'));
		expect(onAbort).toHaveBeenCalledTimes(1);
	});
});
