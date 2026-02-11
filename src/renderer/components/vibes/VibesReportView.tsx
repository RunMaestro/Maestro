import React, { useState, useCallback } from 'react';
import {
	FileText,
	Copy,
	Download,
	Loader2,
	AlertTriangle,
	CheckCircle2,
	Database,
} from 'lucide-react';
import type { Theme } from '../../types';

// ============================================================================
// Types
// ============================================================================

type ReportFormat = 'markdown' | 'html' | 'json';

interface VibesReportViewProps {
	theme: Theme;
	projectPath: string | undefined;
}

// ============================================================================
// Constants
// ============================================================================

const FORMAT_OPTIONS: { value: ReportFormat; label: string; extension: string }[] = [
	{ value: 'markdown', label: 'Markdown', extension: 'md' },
	{ value: 'html', label: 'HTML', extension: 'html' },
	{ value: 'json', label: 'JSON', extension: 'json' },
];

// ============================================================================
// Component
// ============================================================================

/**
 * VIBES Report View — lets users generate and view provenance reports
 * in Markdown, HTML, or JSON format.
 *
 * Features:
 * - Format selector (radio buttons)
 * - Generate button
 * - Report preview area with format-appropriate rendering
 * - Copy to clipboard
 * - Export to file
 * - Loading, error, and build-required states
 */
export const VibesReportView: React.FC<VibesReportViewProps> = ({
	theme,
	projectPath,
}) => {
	const [format, setFormat] = useState<ReportFormat>('markdown');
	const [reportContent, setReportContent] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [needsBuild, setNeedsBuild] = useState(false);
	const [isBuilding, setIsBuilding] = useState(false);
	const [copySuccess, setCopySuccess] = useState(false);
	const [exportSuccess, setExportSuccess] = useState(false);

	// ========================================================================
	// Generate report
	// ========================================================================

	const handleGenerate = useCallback(async () => {
		if (!projectPath) return;

		setIsLoading(true);
		setError(null);
		setNeedsBuild(false);
		setReportContent(null);
		setCopySuccess(false);
		setExportSuccess(false);

		try {
			const result = await window.maestro.vibes.getReport(projectPath, format);
			if (result.success && result.data) {
				setReportContent(result.data);
			} else {
				const errMsg = result.error ?? 'Failed to generate report';
				if (
					errMsg.toLowerCase().includes('build') ||
					errMsg.toLowerCase().includes('database') ||
					errMsg.toLowerCase().includes('audit.db')
				) {
					setNeedsBuild(true);
				} else {
					setError(errMsg);
				}
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : 'Failed to generate report';
			if (
				errMsg.toLowerCase().includes('binary') ||
				errMsg.toLowerCase().includes('not found')
			) {
				setError('vibescheck binary not found. Please install vibescheck or configure its path in Settings.');
			} else {
				setError(errMsg);
			}
		} finally {
			setIsLoading(false);
		}
	}, [projectPath, format]);

	// ========================================================================
	// Build handler
	// ========================================================================

	const handleBuild = useCallback(async () => {
		if (!projectPath) return;
		setIsBuilding(true);
		try {
			const result = await window.maestro.vibes.build(projectPath);
			if (result.success) {
				setNeedsBuild(false);
				// Auto-generate report after build
				handleGenerate();
			} else {
				setError(result.error ?? 'Build failed');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Build failed');
		} finally {
			setIsBuilding(false);
		}
	}, [projectPath, handleGenerate]);

	// ========================================================================
	// Copy to clipboard
	// ========================================================================

	const handleCopy = useCallback(async () => {
		if (!reportContent) return;
		try {
			await navigator.clipboard.writeText(reportContent);
			setCopySuccess(true);
			setTimeout(() => setCopySuccess(false), 2000);
		} catch {
			// Fallback for environments without clipboard API
			const textarea = document.createElement('textarea');
			textarea.value = reportContent;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			document.body.removeChild(textarea);
			setCopySuccess(true);
			setTimeout(() => setCopySuccess(false), 2000);
		}
	}, [reportContent]);

	// ========================================================================
	// Export to file
	// ========================================================================

	const handleExport = useCallback(async () => {
		if (!reportContent) return;

		const formatInfo = FORMAT_OPTIONS.find((f) => f.value === format);
		const ext = formatInfo?.extension ?? 'txt';

		try {
			const savePath = await window.maestro.dialog.saveFile({
				title: 'Export VIBES Report',
				defaultPath: `vibes-report.${ext}`,
				filters: [
					{ name: `${formatInfo?.label ?? 'Report'} files`, extensions: [ext] },
					{ name: 'All files', extensions: ['*'] },
				],
			});

			if (savePath) {
				await window.maestro.fs.writeFile(savePath, reportContent);
				setExportSuccess(true);
				setTimeout(() => setExportSuccess(false), 2000);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Export failed');
		}
	}, [reportContent, format]);

	// ========================================================================
	// Render
	// ========================================================================

	return (
		<div className="flex flex-col h-full">
			{/* Header — format selector + generate button */}
			<div
				className="sticky top-0 z-10 flex flex-col gap-3 px-3 py-3"
				style={{ backgroundColor: theme.colors.bgSidebar }}
			>
				{/* Format selector */}
				<div className="flex items-center gap-3">
					<FileText className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
					<span className="text-[11px] font-semibold" style={{ color: theme.colors.textDim }}>
						Format
					</span>
					<div className="flex items-center gap-1">
						{FORMAT_OPTIONS.map((opt) => (
							<label
								key={opt.value}
								className="flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-[11px] transition-colors"
								style={{
									backgroundColor: format === opt.value ? theme.colors.accentDim : 'transparent',
									color: format === opt.value ? theme.colors.accent : theme.colors.textDim,
								}}
							>
								<input
									type="radio"
									name="vibes-report-format"
									value={opt.value}
									checked={format === opt.value}
									onChange={() => setFormat(opt.value)}
									className="sr-only"
								/>
								{opt.label}
							</label>
						))}
					</div>
				</div>

				{/* Action buttons row */}
				<div className="flex items-center gap-2">
					<button
						onClick={handleGenerate}
						disabled={isLoading || !projectPath}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							opacity: isLoading || !projectPath ? 0.6 : 1,
						}}
					>
						{isLoading ? (
							<Loader2 className="w-3.5 h-3.5 animate-spin" />
						) : (
							<FileText className="w-3.5 h-3.5" />
						)}
						{isLoading ? 'Generating...' : 'Generate Report'}
					</button>

					{reportContent && (
						<>
							<button
								onClick={handleCopy}
								className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: copySuccess ? theme.colors.success : theme.colors.textMain,
								}}
							>
								{copySuccess ? (
									<CheckCircle2 className="w-3.5 h-3.5" />
								) : (
									<Copy className="w-3.5 h-3.5" />
								)}
								{copySuccess ? 'Copied!' : 'Copy'}
							</button>

							<button
								onClick={handleExport}
								className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: exportSuccess ? theme.colors.success : theme.colors.textMain,
								}}
							>
								{exportSuccess ? (
									<CheckCircle2 className="w-3.5 h-3.5" />
								) : (
									<Download className="w-3.5 h-3.5" />
								)}
								{exportSuccess ? 'Saved!' : 'Export'}
							</button>
						</>
					)}
				</div>
			</div>

			{/* Content area */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
				{/* Empty state — no report generated yet */}
				{!reportContent && !isLoading && !error && !needsBuild && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<FileText className="w-6 h-6 opacity-40" style={{ color: theme.colors.textDim }} />
						<span
							className="text-sm font-medium"
							style={{ color: theme.colors.textMain }}
						>
							Generate a provenance report
						</span>
						<span
							className="text-xs max-w-xs"
							style={{ color: theme.colors.textDim }}
						>
							Select a format and click Generate to create a VIBES provenance report for this project.
						</span>
					</div>
				)}

				{/* Loading */}
				{isLoading && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Generating report...
						</span>
					</div>
				)}

				{/* Build Required notice */}
				{!isLoading && needsBuild && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<Database className="w-6 h-6 opacity-60" style={{ color: theme.colors.warning }} />
						<span
							className="text-sm font-medium"
							style={{ color: theme.colors.textMain }}
						>
							Build Required
						</span>
						<span
							className="text-xs max-w-xs"
							style={{ color: theme.colors.textDim }}
						>
							The audit database needs to be built before generating a report.
						</span>
						<button
							onClick={handleBuild}
							disabled={isBuilding}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80 mt-1"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
								opacity: isBuilding ? 0.6 : 1,
							}}
						>
							<Database className="w-3.5 h-3.5" />
							{isBuilding ? 'Building...' : 'Build Now'}
						</button>
					</div>
				)}

				{/* Error */}
				{!isLoading && error && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<AlertTriangle className="w-6 h-6 opacity-60" style={{ color: theme.colors.error }} />
						<span className="text-xs" style={{ color: theme.colors.error }}>
							{error}
						</span>
					</div>
				)}

				{/* Report preview */}
				{!isLoading && !error && !needsBuild && reportContent && (
					<ReportPreview
						theme={theme}
						content={reportContent}
						format={format}
					/>
				)}
			</div>
		</div>
	);
};

// ============================================================================
// Report preview sub-component
// ============================================================================

interface ReportPreviewProps {
	theme: Theme;
	content: string;
	format: ReportFormat;
}

const ReportPreview: React.FC<ReportPreviewProps> = ({ theme, content, format }) => {
	if (format === 'markdown') {
		return (
			<div className="px-3 py-3">
				<pre
					className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed"
					style={{ color: theme.colors.textMain }}
				>
					{content}
				</pre>
			</div>
		);
	}

	if (format === 'html') {
		return (
			<div className="px-3 py-3">
				<pre
					className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed rounded p-3"
					style={{
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					{content}
				</pre>
			</div>
		);
	}

	// JSON — formatted code block
	let formattedJson = content;
	try {
		formattedJson = JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		// Already formatted or not valid JSON — display as-is
	}

	return (
		<div className="px-3 py-3">
			<pre
				className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed rounded p-3"
				style={{
					color: theme.colors.textMain,
					backgroundColor: theme.colors.bgActivity,
				}}
			>
				{formattedJson}
			</pre>
		</div>
	);
};
