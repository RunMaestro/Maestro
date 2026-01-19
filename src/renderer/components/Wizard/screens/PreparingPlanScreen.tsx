/**
 * PreparingPlanScreen.tsx
 *
 * Fourth screen of the onboarding wizard - generates Auto Run documents
 * with no user input, automatically advances to review when complete.
 *
 * Features:
 * - Loading state during document generation with "Preparing Playbooks..."
 * - Error handling with retry option
 * - Real-time file creation display with expand/collapse
 * - Responsive file list that uses available space
 * - Austin facts for entertainment during generation
 * - Auto-advances to phase-review when generation completes
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, FileText } from 'lucide-react';
import type { Theme } from '../../../types';
import { useWizard } from '../WizardContext';
import {
	phaseGenerator,
	wizardDebugLogger,
	type CreatedFileInfo,
} from '../services/phaseGenerator';
import { ScreenReaderAnnouncement } from '../ScreenReaderAnnouncement';
import { getNextAustinFact, parseFactWithLinks, type FactSegment } from '../services/austinFacts';
import { formatSize, formatElapsedTime } from '../../../../shared/formatters';

interface PreparingPlanScreenProps {
	theme: Theme;
}

/**
 * Texas Flag SVG component
 */
function TexasFlag({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}): JSX.Element {
	return (
		<svg viewBox="0 0 150 100" className={className} style={style}>
			{/* Blue vertical stripe */}
			<rect x="0" y="0" width="50" height="100" fill="#002868" />
			{/* White horizontal stripe */}
			<rect x="50" y="0" width="100" height="50" fill="#FFFFFF" />
			{/* Red horizontal stripe */}
			<rect x="50" y="50" width="100" height="50" fill="#BF0A30" />
			{/* White five-pointed star */}
			<polygon
				points="25,15 29.5,30 45,30 32.5,40 37,55 25,45 13,55 17.5,40 5,30 20.5,30"
				fill="#FFFFFF"
			/>
		</svg>
	);
}

/**
 * Get the plain text version of a fact (for typewriter character counting)
 */
function getFactPlainText(fact: string): string {
	// Replace [text](url) with just text
	return fact.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * Render fact segments with proper link handling
 * Links open in system browser via Electron shell.openExternal
 */
function FactContent({
	segments,
	displayLength,
	theme,
}: {
	segments: FactSegment[];
	displayLength: number;
	theme: Theme;
}): JSX.Element {
	let charCount = 0;
	const elements: JSX.Element[] = [];

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];

		if (segment.type === 'text') {
			const segmentLength = segment.content.length;
			const startChar = charCount;
			const endChar = charCount + segmentLength;

			if (displayLength > startChar) {
				const visibleChars = Math.min(displayLength - startChar, segmentLength);
				elements.push(<span key={i}>{segment.content.slice(0, visibleChars)}</span>);
			}
			charCount = endChar;
		} else if (segment.type === 'link') {
			const segmentLength = segment.text.length;
			const startChar = charCount;
			const endChar = charCount + segmentLength;

			if (displayLength > startChar) {
				const visibleChars = Math.min(displayLength - startChar, segmentLength);
				const isFullyVisible = visibleChars === segmentLength;

				if (isFullyVisible) {
					// Render as clickable link
					elements.push(
						<a
							key={i}
							href={segment.url}
							onClick={(e) => {
								e.preventDefault();
								// Open in system browser
								if (!window.maestro?.shell?.openExternal?.(segment.url)) {
									window.open(segment.url, '_blank');
								}
							}}
							className="underline hover:opacity-80 cursor-pointer transition-opacity"
							style={{ color: theme.colors.accent }}
						>
							{segment.text}
						</a>
					);
				} else {
					// Still typing - show as regular text
					elements.push(
						<span key={i} style={{ color: theme.colors.accent }}>
							{segment.text.slice(0, visibleChars)}
						</span>
					);
				}
			}
			charCount = endChar;
		}
	}

	return <>{elements}</>;
}

/**
 * Austin Fact Typewriter - displays random Austin facts with typing effect
 * Supports markdown-style links: [text](url)
 */
function AustinFactTypewriter({ theme }: { theme: Theme }): JSX.Element {
	const [currentFact, setCurrentFact] = useState(() => getNextAustinFact());
	const [displayLength, setDisplayLength] = useState(0);
	const [isTypingComplete, setIsTypingComplete] = useState(false);

	// Parse the fact into segments (text and links)
	const segments = parseFactWithLinks(currentFact);
	const plainText = getFactPlainText(currentFact);

	// Typewriter effect
	useEffect(() => {
		let currentIndex = 0;
		setDisplayLength(0);
		setIsTypingComplete(false);

		const typeInterval = setInterval(() => {
			if (currentIndex < plainText.length) {
				currentIndex++;
				setDisplayLength(currentIndex);
			} else {
				setIsTypingComplete(true);
				clearInterval(typeInterval);
			}
		}, 25); // 25ms per character for readable typing speed

		return () => clearInterval(typeInterval);
	}, [currentFact, plainText.length]);

	// Rotate to new fact 20 seconds after typing completes
	useEffect(() => {
		if (!isTypingComplete) return;

		const rotateTimer = setTimeout(() => {
			setCurrentFact(getNextAustinFact());
		}, 20000); // 20 seconds

		return () => clearTimeout(rotateTimer);
	}, [isTypingComplete]);

	return (
		<div
			className="mt-8 mx-auto px-4 py-4 rounded-lg"
			style={{
				backgroundColor: `${theme.colors.accent}10`,
				border: `1px solid ${theme.colors.accent}30`,
				width: '600px',
				maxWidth: '100%',
			}}
		>
			<div className="flex items-center gap-4">
				<TexasFlag className="w-10 h-7 shrink-0" style={{ opacity: 0.85 }} />
				<div className="flex-1 min-w-0">
					<p
						className="text-xs font-medium uppercase tracking-wide mb-1"
						style={{ color: theme.colors.accent }}
					>
						Austin Facts
					</p>
					<p
						className="text-sm leading-relaxed"
						style={{
							color: theme.colors.textMain,
							minHeight: '3em',
						}}
					>
						<FactContent segments={segments} displayLength={displayLength} theme={theme} />
						{!isTypingComplete && (
							<span
								className="inline-block w-0.5 h-4 ml-0.5 animate-pulse"
								style={{ backgroundColor: theme.colors.accent }}
							/>
						)}
					</p>
				</div>
			</div>
		</div>
	);
}

/**
 * Individual file entry with clickable expand/collapse
 */
function CreatedFileEntry({
	file,
	isExpanded,
	isNewest,
	theme,
	onToggle,
}: {
	file: CreatedFileInfo;
	isExpanded: boolean;
	isNewest: boolean;
	theme: Theme;
	onToggle: () => void;
}): JSX.Element {
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
						title={file.filename}
					>
						{file.filename}
					</span>
				</div>
				<div className="flex items-center gap-3 shrink-0 ml-2">
					{/* Task count badge */}
					{file.taskCount !== undefined && file.taskCount > 0 && (
						<span
							className="text-xs font-medium px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
							}}
						>
							{file.taskCount} {file.taskCount === 1 ? 'task' : 'tasks'}
						</span>
					)}
					{/* File size */}
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{formatSize(file.size)}
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
				{file.description && (
					<div
						className="px-4 pb-3 pl-12 text-xs leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						{file.description}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * File list display for showing created files during generation
 * - Shows files as they are created
 * - Click any file to expand/collapse
 * - Responsive height based on available space
 */
function CreatedFilesList({
	files,
	theme,
}: {
	files: CreatedFileInfo[];
	theme: Theme;
}): JSX.Element | null {
	// Track which files are expanded (by filename)
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	// Track files the user has manually toggled - we never auto-change these
	const userToggledFilesRef = useRef<Set<string>>(new Set());
	// Track the last auto-expanded file so we can collapse it when a new one arrives
	const lastAutoExpandedRef = useRef<string | null>(null);

	// Auto-expand newest file when it's added, collapse previous auto-expanded (if not user-toggled)
	const prevFilesCountRef = useRef(files.length);
	useEffect(() => {
		if (files.length > prevFilesCountRef.current && files.length > 0) {
			const newestFile = files[files.length - 1];

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

			// Track this as the new auto-expanded file
			lastAutoExpandedRef.current = newestFile.filename;
		}
		prevFilesCountRef.current = files.length;
	}, [files]);

	const toggleFile = useCallback((filename: string) => {
		// Mark this file as user-toggled so we never auto-change it
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

	if (files.length === 0) return null;

	const newestIndex = files.length - 1;

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
					Work Plans Drafted ({files.length})
				</span>
			</div>
			{/* Responsive list - grows to fit content but scrolls if too many */}
			<div
				className="overflow-y-auto"
				style={{
					maxHeight: 'calc(40vh - 100px)', // Responsive based on viewport
				}}
			>
				{files.map((file, index) => (
					<div
						key={file.path}
						style={{
							borderBottom:
								index < files.length - 1 ? `1px solid ${theme.colors.border}` : undefined,
						}}
					>
						<CreatedFileEntry
							file={file}
							isExpanded={expandedFiles.has(file.filename)}
							isNewest={index === newestIndex}
							theme={theme}
							onToggle={() => toggleFile(file.filename)}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Loading indicator with animated spinner and message
 */
function LoadingIndicator({
	message,
	theme,
	createdFiles = [],
	startTime,
}: {
	message: string;
	theme: Theme;
	createdFiles?: CreatedFileInfo[];
	startTime?: number;
}): JSX.Element {
	// Calculate total tasks across all files
	const totalTasks = createdFiles.reduce((sum, file) => sum + (file.taskCount || 0), 0);

	// Track elapsed time with a timer that updates every second
	const [elapsedMs, setElapsedMs] = useState(0);

	useEffect(() => {
		if (!startTime) return;

		// Update immediately
		setElapsedMs(Date.now() - startTime);

		// Update every second
		const interval = setInterval(() => {
			setElapsedMs(Date.now() - startTime);
		}, 1000);

		return () => clearInterval(interval);
	}, [startTime]);

	return (
		<div className="flex-1 flex flex-col p-6 items-center justify-center">
			{/* Main loading content - centered vertically */}
			<div className="flex flex-col items-center">
				{/* Animated spinner */}
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

				{/* Message */}
				<h3
					className="text-lg font-semibold mb-1 text-center"
					style={{ color: theme.colors.textMain }}
				>
					{message}
				</h3>

				{/* Subtitle with elapsed time */}
				<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
					This may take a while. We're creating detailed task documents based on your project
					requirements.
				</p>
				{startTime && elapsedMs > 0 && (
					<p className="text-xs mt-1 font-mono" style={{ color: theme.colors.textDim }}>
						Elapsed: {formatElapsedTime(elapsedMs)}
					</p>
				)}

				{/* Total task count (replaces bouncing dots when tasks exist) */}
				{totalTasks > 0 ? (
					<div className="mt-4 flex items-center gap-2">
						<span className="text-3xl font-bold" style={{ color: theme.colors.accent }}>
							{totalTasks}
						</span>
						<span className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
							{totalTasks === 1 ? 'Task' : 'Tasks'} Planned
						</span>
					</div>
				) : (
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
				)}

				{/* Created files list */}
				<CreatedFilesList files={createdFiles} theme={theme} />

				{/* Austin Fact */}
				<AustinFactTypewriter theme={theme} />
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
 * Error display with retry option
 */
function ErrorDisplay({
	error,
	onRetry,
	onSkip,
	theme,
}: {
	error: string;
	onRetry: () => void;
	onSkip: () => void;
	theme: Theme;
}): JSX.Element {
	const handleDownloadDebugLogs = () => {
		wizardDebugLogger.downloadLogs();
	};

	return (
		<div className="flex-1 flex flex-col items-center justify-center p-8">
			{/* Error icon */}
			<div
				className="w-16 h-16 rounded-full flex items-center justify-center mb-6"
				style={{ backgroundColor: `${theme.colors.error}20` }}
			>
				<svg className="w-8 h-8" fill="none" stroke={theme.colors.error} viewBox="0 0 24 24">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
			</div>

			{/* Error message */}
			<h3
				className="text-xl font-semibold mb-2 text-center"
				style={{ color: theme.colors.textMain }}
			>
				Generation Failed
			</h3>
			<p className="text-sm text-center max-w-md mb-6" style={{ color: theme.colors.error }}>
				{error}
			</p>

			{/* Action buttons */}
			<div className="flex items-center gap-4">
				<button
					onClick={onRetry}
					className="px-6 py-2.5 rounded-lg font-medium transition-all hover:scale-105"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					Try Again
				</button>
				<button
					onClick={onSkip}
					className="px-6 py-2.5 rounded-lg font-medium transition-colors"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
					}}
				>
					Go Back
				</button>
			</div>

			{/* Debug logs download link */}
			<button
				onClick={handleDownloadDebugLogs}
				className="mt-6 text-xs underline hover:opacity-80 transition-opacity cursor-pointer"
				style={{ color: theme.colors.textDim }}
			>
				(Debug Logs)
			</button>
		</div>
	);
}

/**
 * PreparingPlanScreen - Document generation (no user input)
 *
 * This screen handles:
 * 1. Triggering document generation when mounted
 * 2. Showing loading state with "Preparing Playbooks..."
 * 3. Handling errors with retry option
 * 4. Auto-advancing to phase-review when generation completes
 */
export function PreparingPlanScreen({ theme }: PreparingPlanScreenProps): JSX.Element {
	const {
		state,
		setGeneratingDocuments,
		setGeneratedDocuments,
		setGenerationError,
		previousStep,
		nextStep,
	} = useWizard();

	const [progressMessage, setProgressMessage] = useState('Generating Auto Run Documents...');
	const generationStartedRef = useRef(false);

	// Track files as they are created (from FS watcher or saveDocuments callback)
	const [createdFiles, setCreatedFiles] = useState<CreatedFileInfo[]>([]);
	// Track filenames we've already seen to avoid duplicates
	const seenFilesRef = useRef<Set<string>>(new Set());

	// Track generation start time for elapsed time display
	const [generationStartTime, setGenerationStartTime] = useState<number | undefined>(undefined);

	// Screen reader announcement state
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	/**
	 * Start the document generation process
	 */
	const startGeneration = useCallback(async () => {
		// Prevent multiple concurrent generations
		if (phaseGenerator.isGenerationInProgress()) {
			return;
		}

		setGeneratingDocuments(true);
		setGenerationError(null);
		setProgressMessage('Generating Auto Run Documents...');
		setCreatedFiles([]); // Reset files list
		seenFilesRef.current.clear(); // Reset seen files tracking
		setGenerationStartTime(Date.now()); // Start elapsed time tracking

		// Announce generation start
		setAnnouncement('Preparing your Playbooks. This may take a while.');
		setAnnouncementKey((prev) => prev + 1);

		/**
		 * Helper to add a file to the created files list, avoiding duplicates
		 */
		const addCreatedFile = (file: CreatedFileInfo) => {
			// Use filename as the unique key to avoid duplicates
			if (!seenFilesRef.current.has(file.filename)) {
				seenFilesRef.current.add(file.filename);
				setCreatedFiles((prev) => [...prev, file]);
			} else {
				// Update the existing file entry (e.g., if size changed)
				setCreatedFiles((prev) => prev.map((f) => (f.filename === file.filename ? file : f)));
			}
		};

		try {
			// Generate documents in the "Initiation" subfolder
			const result = await phaseGenerator.generateDocuments(
				{
					agentType: state.selectedAgent!,
					directoryPath: state.directoryPath,
					projectName: state.agentName || 'My Project',
					conversationHistory: state.conversationHistory,
					subfolder: 'Initiation',
				},
				{
					onStart: () => {
						setProgressMessage('Starting document generation...');
					},
					onProgress: (message) => {
						setProgressMessage(message);
					},
					onChunk: () => {
						// Could show streaming output here in the future
					},
					// Called when a file is detected by FS watcher or saveDocuments
					onFileCreated: (file) => {
						addCreatedFile(file);
					},
					// Called on any activity (data chunk or file change) - for future use
					onActivity: () => {
						// Activity occurred, timeout was reset in phaseGenerator
					},
					onComplete: async (genResult) => {
						if (genResult.success && genResult.documents) {
							// If documents were already on disk, skip saving
							if (genResult.documentsFromDisk) {
								console.log('[PreparingPlanScreen] Documents already on disk, skipping save');
								setGeneratedDocuments(genResult.documents);
								setGeneratingDocuments(false);

								// Announce success and auto-advance
								const taskCount = genResult.documents[0]?.taskCount || 0;
								setAnnouncement(
									`Playbooks created successfully with ${taskCount} tasks. Proceeding to review.`
								);
								setAnnouncementKey((prev) => prev + 1);

								// Auto-advance to review screen
								setTimeout(() => nextStep(), 500);
								return;
							}

							// Save documents to disk in "Initiation" subfolder
							setProgressMessage('Saving documents...');
							const saveResult = await phaseGenerator.saveDocuments(
								state.directoryPath,
								genResult.documents,
								(file) => {
									// Add file to the created files list as it's saved
									addCreatedFile(file);
								},
								'Initiation' // Save in Initiation subfolder
							);

							if (saveResult.success) {
								// Update context with generated documents (including saved paths)
								setGeneratedDocuments(genResult.documents);
								setGeneratingDocuments(false);

								// Announce success
								const taskCount = genResult.documents[0]?.taskCount || 0;
								setAnnouncement(
									`Playbooks created successfully with ${taskCount} tasks. Proceeding to review.`
								);
								setAnnouncementKey((prev) => prev + 1);

								// Auto-advance to review screen
								setTimeout(() => nextStep(), 500);
							} else {
								setGenerationError(saveResult.error || 'Failed to save documents');
								setGeneratingDocuments(false);

								// Announce save error
								setAnnouncement(`Error: Failed to save documents. ${saveResult.error || ''}`);
								setAnnouncementKey((prev) => prev + 1);
							}
						}
					},
					onError: (error) => {
						setGenerationError(error);
						setGeneratingDocuments(false);

						// Announce error
						setAnnouncement(`Error generating Playbooks: ${error}. You can try again or go back.`);
						setAnnouncementKey((prev) => prev + 1);
					},
				}
			);

			// Handle result if not handled by callbacks
			if (!result.success && result.error) {
				setGenerationError(result.error);
				setGeneratingDocuments(false);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			setGenerationError(errorMessage);
			setGeneratingDocuments(false);
		}
	}, [
		state.selectedAgent,
		state.directoryPath,
		state.agentName,
		state.conversationHistory,
		setGeneratingDocuments,
		setGeneratedDocuments,
		setGenerationError,
		nextStep,
	]);

	/**
	 * Handle retry after error
	 */
	const handleRetry = useCallback(() => {
		setGenerationError(null);
		generationStartedRef.current = false;
		startGeneration();
	}, [startGeneration, setGenerationError]);

	/**
	 * Handle going back to conversation
	 */
	const handleGoBack = useCallback(() => {
		setGenerationError(null);
		previousStep();
	}, [previousStep, setGenerationError]);

	// Start generation when screen mounts (only once)
	useEffect(() => {
		// Only start if we haven't started yet and don't already have documents
		if (!generationStartedRef.current && state.generatedDocuments.length === 0) {
			generationStartedRef.current = true;
			startGeneration();
		} else if (state.generatedDocuments.length > 0) {
			// Already have documents - auto-advance to review
			nextStep();
		}
	}, [state.generatedDocuments.length]);

	// Cleanup on unmount - abort any in-progress generation
	useEffect(() => {
		return () => {
			// Abort generation and clean up resources when component unmounts
			phaseGenerator.abort();
		};
	}, []);

	// Render based on current state
	const announcementElement = (
		<ScreenReaderAnnouncement
			message={announcement}
			announceKey={announcementKey}
			politeness="polite"
		/>
	);

	if (state.generationError) {
		return (
			<>
				{announcementElement}
				<ErrorDisplay
					error={state.generationError}
					onRetry={handleRetry}
					onSkip={handleGoBack}
					theme={theme}
				/>
			</>
		);
	}

	// Always show loading indicator during generation
	return (
		<>
			{announcementElement}
			<LoadingIndicator
				message={progressMessage}
				theme={theme}
				createdFiles={createdFiles}
				startTime={generationStartTime}
			/>
		</>
	);
}
