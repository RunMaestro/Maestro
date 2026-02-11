import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VibesReportView } from '../../../../renderer/components/vibes/VibesReportView';
import type { Theme } from '../../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	FileText: () => <span data-testid="icon-filetext">FileText</span>,
	Copy: () => <span data-testid="icon-copy">Copy</span>,
	Download: () => <span data-testid="icon-download">Download</span>,
	Loader2: () => <span data-testid="icon-loader">Loader2</span>,
	AlertTriangle: () => <span data-testid="icon-alert">AlertTriangle</span>,
	CheckCircle2: () => <span data-testid="icon-check">CheckCircle2</span>,
	Database: () => <span data-testid="icon-database">Database</span>,
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#1e1f29',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.2)',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

const mockReportMarkdown = '# VIBES Provenance Report\n\n## Summary\n- 10 annotations\n- 3 models';
const mockReportHtml = '<html><body><h1>VIBES Report</h1></body></html>';
const mockReportJson = '{"summary":{"annotations":10,"models":3},"files":[]}';

// Setup window.maestro mock
const mockGetReport = vi.fn();
const mockBuild = vi.fn();
const mockSaveFile = vi.fn();
const mockWriteFile = vi.fn();

// Mock clipboard
const mockClipboardWriteText = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	mockGetReport.mockResolvedValue({
		success: true,
		data: mockReportMarkdown,
	});

	mockBuild.mockResolvedValue({ success: true });
	mockSaveFile.mockResolvedValue('/tmp/vibes-report.md');
	mockWriteFile.mockResolvedValue({ success: true });

	(window as any).maestro = {
		vibes: {
			getReport: mockGetReport,
			build: mockBuild,
		},
		dialog: {
			saveFile: mockSaveFile,
		},
		fs: {
			writeFile: mockWriteFile,
		},
	};

	// Mock clipboard API
	Object.assign(navigator, {
		clipboard: {
			writeText: mockClipboardWriteText.mockResolvedValue(undefined),
		},
	});
});

describe('VibesReportView', () => {
	it('renders empty state before generating a report', () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);
		expect(screen.getByText('Generate a provenance report')).toBeTruthy();
		expect(screen.getByText(/Select a format and click Generate/)).toBeTruthy();
	});

	it('renders format selector with three options', () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);
		expect(screen.getByText('Markdown')).toBeTruthy();
		expect(screen.getByText('HTML')).toBeTruthy();
		expect(screen.getByText('JSON')).toBeTruthy();
	});

	it('renders generate button', () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);
		expect(screen.getByText('Generate Report')).toBeTruthy();
	});

	it('shows loading state during report generation', async () => {
		// Make getReport hang
		mockGetReport.mockReturnValue(new Promise(() => {}));

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText('Generating...')).toBeTruthy();
			expect(screen.getByText('Generating report...')).toBeTruthy();
		});
	});

	it('generates and displays a markdown report', async () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText(/VIBES Provenance Report/)).toBeTruthy();
		});

		expect(screen.getByText(/10 annotations/)).toBeTruthy();
		expect(mockGetReport).toHaveBeenCalledWith('/test/project', 'markdown');
	});

	it('generates and displays an HTML report', async () => {
		mockGetReport.mockResolvedValue({
			success: true,
			data: mockReportHtml,
		});

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		// Select HTML format
		fireEvent.click(screen.getByText('HTML'));
		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText(mockReportHtml)).toBeTruthy();
		});

		expect(mockGetReport).toHaveBeenCalledWith('/test/project', 'html');
	});

	it('generates and displays a JSON report with formatting', async () => {
		mockGetReport.mockResolvedValue({
			success: true,
			data: mockReportJson,
		});

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		// Select JSON format
		fireEvent.click(screen.getByText('JSON'));
		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			// JSON should be pretty-printed — check for key content
			expect(screen.getByText(/annotations/)).toBeTruthy();
		});

		expect(mockGetReport).toHaveBeenCalledWith('/test/project', 'json');
	});

	it('shows copy and export buttons after report is generated', async () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		// Before generation — no copy/export buttons
		expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
		expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy();
			expect(screen.getByRole('button', { name: /Export/ })).toBeTruthy();
		});
	});

	it('copies report to clipboard when copy button is clicked', async () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: /Copy/ }));

		await waitFor(() => {
			expect(mockClipboardWriteText).toHaveBeenCalledWith(mockReportMarkdown);
		});
	});

	it('exports report to file when export button is clicked', async () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText('Export')).toBeTruthy();
		});

		fireEvent.click(screen.getByText('Export'));

		await waitFor(() => {
			expect(mockSaveFile).toHaveBeenCalledWith({
				title: 'Export VIBES Report',
				defaultPath: 'vibes-report.md',
				filters: [
					{ name: 'Markdown files', extensions: ['md'] },
					{ name: 'All files', extensions: ['*'] },
				],
			});
		});

		await waitFor(() => {
			expect(mockWriteFile).toHaveBeenCalledWith('/tmp/vibes-report.md', mockReportMarkdown);
		});
	});

	it('shows error state when report generation fails', async () => {
		mockGetReport.mockResolvedValue({
			success: false,
			error: 'Something went wrong',
		});

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText('Something went wrong')).toBeTruthy();
		});
	});

	it('shows Build Required when database is missing', async () => {
		mockGetReport.mockResolvedValue({
			success: false,
			error: 'audit.db not found. Run build first.',
		});

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText('Build Required')).toBeTruthy();
		});
		expect(screen.getByText('Build Now')).toBeTruthy();
	});

	it('calls build when Build Now button is clicked', async () => {
		mockGetReport.mockResolvedValueOnce({
			success: false,
			error: 'audit.db not found. Run build first.',
		});

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText('Build Now')).toBeTruthy();
		});

		// After build succeeds, the report will be auto-generated
		mockGetReport.mockResolvedValueOnce({
			success: true,
			data: mockReportMarkdown,
		});

		fireEvent.click(screen.getByText('Build Now'));

		await waitFor(() => {
			expect(mockBuild).toHaveBeenCalledWith('/test/project');
		});
	});

	it('shows binary not found error when vibescheck is missing', async () => {
		mockGetReport.mockRejectedValue(new Error('binary not found'));

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText(/vibescheck binary not found/)).toBeTruthy();
		});
	});

	it('disables generate button when no project path', () => {
		render(
			<VibesReportView
				theme={mockTheme}
				projectPath={undefined}
			/>,
		);

		const button = screen.getByText('Generate Report').closest('button');
		expect(button?.disabled).toBe(true);
	});

	it('does not show export buttons when save dialog is cancelled', async () => {
		// saveFile returns null when user cancels
		mockSaveFile.mockResolvedValue(null);

		render(
			<VibesReportView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		fireEvent.click(screen.getByText('Generate Report'));

		await waitFor(() => {
			expect(screen.getByText('Export')).toBeTruthy();
		});

		fireEvent.click(screen.getByText('Export'));

		await waitFor(() => {
			expect(mockSaveFile).toHaveBeenCalled();
		});

		// writeFile should NOT have been called
		expect(mockWriteFile).not.toHaveBeenCalled();
	});
});
