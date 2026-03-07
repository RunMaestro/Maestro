/**
 * DocumentGenerationView.tsx
 *
 * The main takeover component for document generation in the inline wizard.
 * Takes over the AI terminal area (not a modal) when confidence reaches threshold
 * and user proceeds. Displays:
 * - Document selector dropdown at top
 * - Main content area showing streaming preview or final document
 * - Austin facts rotating in corner during generation
 * - Completion overlay with confetti when generation finishes
 *
 * This component is extracted/shared with PhaseReviewScreen.tsx to maintain consistency.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight, FileText, Check } from 'lucide-react';
import type { Theme } from '../../types';
import type { GeneratedDocument } from '../Wizard/WizardContext';
import { AustinFactsDisplay } from './AustinFactsDisplay';
import { formatSize, formatElapsedTime } from '../../../shared/formatters';

/**
 * Props for DocumentGenerationView
 */
export interface DocumentGenerationViewProps {
	/** Theme for styling */
	theme: Theme;
	/** Array of generated documents */
	documents: GeneratedDocument[];
	/** Index of the currently selected document */
	currentDocumentIndex: number;
	/** Whether documents are still being generated */
	isGenerating: boolean;
	/** Streaming content being generated (shown during generation) */
	streamingContent?: string;
	/** Called when generation completes and user clicks Done */
	onComplete: () => void;
	/** Called when user selects a different document */
	onDocumentSelect: (index: number) => void;
	/** Folder path for Auto Run docs */
	folderPath?: string;
	/** Called when document content changes (for editing) */
	onContentChange?: (content: string, docIndex: number) => void;
	/** Progress message to show during generation */
	progressMessage?: string;
	/** Current document being generated (for progress indicator) */
	currentGeneratingIndex?: number;
	/** Total number of documents to generate (for progress indicator) */
	totalDocuments?: number;
	/** Called when user wants to cancel generation */
	onCancel?: () => void;
	/** Subfolder name where documents are saved (for completion message) */
	subfolderName?: string;
}

/**
 * Count tasks in markdown content
 */
function countTasks(content: string): number {
	const matches = content.match(/^- \[([ x])\]/gm);
	return matches ? matches.length : 0;
}

/**
 * Individual file entry in the created files list
 */
function CreatedFileEntry({
	doc,
	isExpanded,
	isNewest,
	theme,
	onToggle,
}: {
	doc: GeneratedDocument;
	isExpanded: boolean;
	isNewest: boolean;
	theme: Theme;
	onToggle: () => void;
}): JSX.Element {
	const taskCount = countTasks(doc.content);
	const fileSize = new Blob([doc.content]).size;

	// Extract first paragraph as description
	const description = useMemo(() => {
		const lines = doc.content.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			// Skip headers and empty lines
			if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
			// Return first paragraph, truncated
			return trimmed.length > 150 ? trimmed.slice(0, 147) + '...' : trimmed;
		}
		return null;
	}, [doc.content]);

	return (
		<div
			className="overflow-hidden transition-all duration-300"
			style={{
				animation: isNewest ? 'fadeSlideIn 0.3s ease-out' : undefined,
			}}
		>
			{/* Header row - clickable to expand/collapse */}
			<button
				onClick={onToggle}
				className="w-full px-4 py-2.5 flex items-center justify-between text-sm text-left hover:opacity-80 transition-opacity"
				style={{
					backgroundColor: isExpanded ? `${theme.colors.accent}10` : 'transparent',
				}}
			>
				<div className="flex items-center gap-2 min-w-0">
					{isExpanded ? (
						<ChevronDown
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<ChevronRight
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					)}
					<span style={{ color: theme.colors.success }}>✓</span>
					<span
						className="truncate font-medium"
						style={{ color: theme.colors.textMain }}
						title={doc.filename}
					>
						{doc.filename}
					</span>
				</div>
				<div className="flex items-center gap-3 shrink-0 ml-2">
					{/* Task count badge */}
					{taskCount > 0 && (
						<span
							className="text-xs font-medium px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
							}}
						>
							{taskCount} {taskCount === 1 ? 'task' : 'tasks'}
						</span>
					)}
					{/* File size */}
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{formatSize(fileSize)}
					</span>
				</div>
			</button>

			{/* Description - shown when expanded */}
			<div
				className="overflow-hidden transition-all duration-300 ease-out"
				style={{
					maxHeight: isExpanded ? '120px' : '0px',
					opacity: isExpanded ? 1 : 0,
				}}
			>
				{description && (
					<div
						className="px-4 pb-3 pl-12 text-xs leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						{description}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * List of created files during generation
 */
function CreatedFilesList({
	documents,
	theme,
}: {
	documents: GeneratedDocument[];
	theme: Theme;
}): JSX.Element | null {
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const userToggledFilesRef = useRef<Set<string>>(new Set());
	const lastAutoExpandedRef = useRef<string | null>(null);

	// Auto-expand newest file when it's added
	const prevFilesCountRef = useRef(documents.length);
	useEffect(() => {
		if (documents.length > prevFilesCountRef.current && documents.length > 0) {
			const newestFile = documents[documents.length - 1];

			setExpandedFiles((prev) => {
				const next = new Set(prev);

				// Collapse the previous auto-expanded file (only if user hasn't touched it)
				if (
					lastAutoExpandedRef.current &&
					!userToggledFilesRef.current.has(lastAutoExpandedRef.current)
				) {
					next.delete(lastAutoExpandedRef.current);
				}

				// Expand the new file
				next.add(newestFile.filename);
				return next;
			});

			lastAutoExpandedRef.current = newestFile.filename;
		}
		prevFilesCountRef.current = documents.length;
	}, [documents]);

	const toggleFile = useCallback((filename: string) => {
		userToggledFilesRef.current.add(filename);
		setExpandedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(filename)) {
				next.delete(filename);
			} else {
				next.add(filename);
			}
			return next;
		});
	}, []);

	if (documents.length === 0) return null;

	const newestIndex = documents.length - 1;

	return (
		<div
			className="mt-6 mx-auto rounded-lg overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				width: '600px',
				maxWidth: '100%',
			}}
		>
			<div
				className="px-4 py-2.5 border-b flex items-center gap-2"
				style={{
					backgroundColor: `${theme.colors.success}15`,
					borderColor: theme.colors.border,
				}}
			>
				<FileText className="w-4 h-4" style={{ color: theme.colors.success }} />
				<span
					className="text-xs font-medium uppercase tracking-wide"
					style={{ color: theme.colors.success }}
				>
					Work Plans Drafted ({documents.length})
				</span>
			</div>
			<div
				className="overflow-y-auto"
				style={{
					maxHeight: 'calc(40vh - 100px)',
				}}
			>
				{documents.map((doc, index) => (
					<div
						key={doc.filename}
						style={{
							borderBottom:
								index < documents.length - 1 ? `1px solid ${theme.colors.border}` : undefined,
						}}
					>
						<CreatedFileEntry
							doc={doc}
							isExpanded={expandedFiles.has(doc.filename)}
							isNewest={index === newestIndex}
							theme={theme}
							onToggle={() => toggleFile(doc.filename)}
						/>
					</div>
				))}
			</div>

			{/* Animation styles */}
			<style>{`
        @keyframes fadeSlideIn {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
		</div>
	);
}

/**
 * DocumentGenerationView - Main component for document generation takeover
 */
export function DocumentGenerationView({
	theme,
	documents,
	currentDocumentIndex: _currentDocumentIndex,
	isGenerating,
	streamingContent: _streamingContent,
	onComplete,
	onDocumentSelect: _onDocumentSelect,
	folderPath: _folderPath,
	onContentChange: _onContentChange,
	progressMessage: _progressMessage,
	currentGeneratingIndex: _currentGeneratingIndex,
	totalDocuments: _totalDocuments,
	onCancel,
	subfolderName,
}: DocumentGenerationViewProps): JSX.Element {
	// Calculate total tasks
	const totalTasks = documents.reduce((sum, doc) => sum + countTasks(doc.content), 0);

	// Track elapsed time for generation
	const [startTime] = useState(() => Date.now());
	const [elapsedMs, setElapsedMs] = useState(0);

	useEffect(() => {
		if (!isGenerating) return;

		// Update immediately
		setElapsedMs(Date.now() - startTime);

		// Update every second
		const interval = setInterval(() => {
			setElapsedMs(Date.now() - startTime);
		}, 1000);

		return () => clearInterval(interval);
	}, [isGenerating, startTime]);

	// Determine if generation is complete
	const isComplete = !isGenerating && documents.length > 0;

	// Fallback - no documents and not generating
	if (!isGenerating && documents.length === 0) {
		return (
			<div
				className="flex flex-col h-full items-center justify-center p-6"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				<p style={{ color: theme.colors.textDim }}>No documents generated yet.</p>
				{onCancel && (
					<button
						onClick={onCancel}
						className="mt-4 px-4 py-2 text-sm rounded"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						Cancel
					</button>
				)}
			</div>
		);
	}

	// Main view - same layout for generating and complete states
	// Only difference: Austin Facts vs completion button at bottom
	return (
		<div
			className="flex flex-col h-full items-center justify-center p-6 overflow-y-auto"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			{/* Main content - centered vertically */}
			<div className="flex flex-col items-center">
				{/* Header: Spinner when generating, Checkmark when complete */}
				{isComplete ? (
					<div
						className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
						style={{ backgroundColor: `${theme.colors.success}20` }}
					>
						<Check className="w-7 h-7" style={{ color: theme.colors.success }} />
					</div>
				) : (
					<div className="relative mb-4">
						<div
							className="w-14 h-14 rounded-full border-4 border-t-transparent animate-spin"
							style={{
								borderColor: `${theme.colors.border}`,
								borderTopColor: theme.colors.accent,
							}}
						/>
						{/* Inner pulsing circle */}
						<div className="absolute inset-0 flex items-center justify-center">
							<div
								className="w-7 h-7 rounded-full animate-pulse"
								style={{ backgroundColor: `${theme.colors.accent}30` }}
							/>
						</div>
					</div>
				)}

				{/* Title */}
				<h3
					className="text-lg font-semibold mb-1 text-center"
					style={{ color: theme.colors.textMain }}
				>
					{isComplete ? 'Documentation generation complete.' : 'Generating Auto Run Documents...'}
				</h3>

				{/* Subtitle: location message when complete, elapsed time during generation */}
				{isComplete ? (
					<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
						Available under{' '}
						<span style={{ color: theme.colors.accent, fontWeight: 500 }}>
							{subfolderName || 'Auto Run Docs'}/
						</span>
					</p>
				) : (
					<>
						<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
							This may take a while. We're creating detailed task documents based on your project
							requirements.
						</p>
						{elapsedMs > 0 && (
							<p className="text-xs mt-1 font-mono" style={{ color: theme.colors.textDim }}>
								Elapsed: {formatElapsedTime(elapsedMs)}
							</p>
						)}
					</>
				)}

				{/* Total task count */}
				{totalTasks > 0 ? (
					<div className="mt-4 flex items-center gap-2">
						<span className="text-3xl font-bold" style={{ color: theme.colors.accent }}>
							{totalTasks}
						</span>
						<span className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
							{totalTasks === 1 ? 'Task' : 'Tasks'} Planned
						</span>
					</div>
				) : !isComplete ? (
					<div className="flex items-center gap-1 mt-3">
						{[0, 1, 2].map((i) => (
							<div
								key={i}
								className="w-2 h-2 rounded-full"
								style={{
									backgroundColor: theme.colors.accent,
									animation: `bounce-dot 0.8s infinite ${i * 150}ms`,
								}}
							/>
						))}
					</div>
				) : null}

				{/* Created files list */}
				<CreatedFilesList documents={documents} theme={theme} />

				{/* Bottom section: Austin Facts during generation, Exit Wizard button when done */}
				{isComplete ? (
					<button
						onClick={onComplete}
						className="mt-8 px-6 py-3 text-base font-semibold rounded-lg transition-all hover:opacity-90 hover:scale-105"
						style={{
							backgroundColor: theme.colors.success,
							color: 'white',
						}}
					>
						Exit Wizard
					</button>
				) : (
					<>
						{/* Cancel button */}
						{onCancel && (
							<button
								onClick={onCancel}
								className="mt-4 px-4 py-2 text-sm rounded transition-colors hover:opacity-80"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Cancel
							</button>
						)}

						{/* Austin Facts - shown during generation */}
						<div className="mt-8">
							<AustinFactsDisplay theme={theme} isVisible={true} centered />
						</div>
					</>
				)}
			</div>

			{/* Animation styles */}
			<style>{`
        @keyframes bounce-dot {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-6px);
          }
        }
      `}</style>
		</div>
	);
}

// Re-export standalone components from their files
export { AustinFactsDisplay } from './AustinFactsDisplay';
export { StreamingDocumentPreview } from './StreamingDocumentPreview';
export { GenerationCompleteOverlay } from './GenerationCompleteOverlay';
