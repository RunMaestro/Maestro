/**
 * ResponseViewer component for Maestro mobile web interface
 *
 * Full-screen modal for viewing complete AI responses.
 * Features:
 * - Full-screen overlay for immersive reading
 * - Displays the complete response text with proper formatting
 * - Syntax highlighting for code blocks (task 1.33)
 * - Copy button for each code block with visual feedback (task 1.34)
 * - Monospace font for code readability
 * - Swipe down to dismiss (task 1.35)
 * - Swipe left/right to navigate between responses (task 1.36)
 * - Pinch-to-zoom for code readability (task 1.37)
 * - Share/copy functionality (task 1.31)
 * - Scroll to read long responses
 *
 * This component is triggered when users tap the last response preview
 * in the SessionStatusBanner component.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeColors, useTheme } from '../components/ThemeProvider';
import type { LastResponsePreview } from '../hooks/useSessions';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { webLogger } from '../utils/logger';
import { stripAnsiCodes } from '../../shared/stringUtils';

/**
 * Represents a response item that can be navigated to
 */
export interface ResponseItem {
	/** The response preview data */
	response: LastResponsePreview;
	/** Session ID this response belongs to */
	sessionId: string;
	/** Session name for display */
	sessionName: string;
}

/**
 * Props for ResponseViewer component
 */
export interface ResponseViewerProps {
	/** Whether the viewer is currently open */
	isOpen: boolean;
	/** The response data to display (preview data) - used for single response mode */
	response: LastResponsePreview | null;
	/** All responses available for navigation (optional - enables swipe navigation) */
	allResponses?: ResponseItem[];
	/** Index of the currently selected response in allResponses array */
	currentIndex?: number;
	/** Callback when navigating to a different response */
	onNavigate?: (index: number) => void;
	/** The full response text (fetched from server) */
	fullText?: string | null;
	/** Whether full text is currently loading */
	isLoading?: boolean;
	/** Callback when the viewer should close */
	onClose: () => void;
	/** Session name for display context */
	sessionName?: string;
}

/**
 * Format timestamp to human-readable string
 */
function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

/**
 * Language mapping for common file extensions and language identifiers
 */
const LANGUAGE_MAP: Record<string, string> = {
	ts: 'typescript',
	tsx: 'tsx',
	js: 'javascript',
	jsx: 'jsx',
	json: 'json',
	md: 'markdown',
	py: 'python',
	python: 'python',
	rb: 'ruby',
	ruby: 'ruby',
	go: 'go',
	golang: 'go',
	rs: 'rust',
	rust: 'rust',
	java: 'java',
	c: 'c',
	cpp: 'cpp',
	'c++': 'cpp',
	cs: 'csharp',
	csharp: 'csharp',
	php: 'php',
	html: 'html',
	css: 'css',
	scss: 'scss',
	sass: 'sass',
	sql: 'sql',
	sh: 'bash',
	bash: 'bash',
	shell: 'bash',
	zsh: 'bash',
	yaml: 'yaml',
	yml: 'yaml',
	toml: 'toml',
	xml: 'xml',
	swift: 'swift',
	kotlin: 'kotlin',
	kt: 'kotlin',
	scala: 'scala',
	r: 'r',
	lua: 'lua',
	perl: 'perl',
	dockerfile: 'dockerfile',
	docker: 'dockerfile',
	makefile: 'makefile',
	make: 'makefile',
	graphql: 'graphql',
	gql: 'graphql',
	diff: 'diff',
	patch: 'diff',
};

/**
 * Normalize language identifier to a known language
 */
function normalizeLanguage(lang: string | undefined): string {
	if (!lang) return 'text';
	const normalized = lang.toLowerCase().trim();
	return LANGUAGE_MAP[normalized] || normalized || 'text';
}

/**
 * Represents a parsed segment of the response text
 */
interface TextSegment {
	type: 'text' | 'code';
	content: string;
	language?: string;
}

/**
 * Parse response text to identify code blocks
 * Supports markdown-style triple backticks with optional language identifier
 */
function parseTextWithCodeBlocks(text: string): TextSegment[] {
	const segments: TextSegment[] = [];

	// Regex to match code blocks: ```language\ncode\n```
	// Supports optional language identifier after opening backticks
	const codeBlockRegex = /```([^\n\r`]*)\n?([\s\S]*?)```/g;

	let lastIndex = 0;
	let match;

	while ((match = codeBlockRegex.exec(text)) !== null) {
		// Add text before the code block
		if (match.index > lastIndex) {
			const textContent = text.slice(lastIndex, match.index);
			if (textContent.trim()) {
				segments.push({
					type: 'text',
					content: textContent,
				});
			}
		}

		// Add the code block
		let language = (match[1] || '').trim();
		let code = match[2] || '';

		if (!code.trim() && language.includes(' ')) {
			const [languageToken, ...inlineCodeParts] = language.split(/\s+/);
			const inlineCode = inlineCodeParts.join(' ');
			if (inlineCode.trim()) {
				language = languageToken;
				code = inlineCode;
			}
		}

		// Only add non-empty code blocks
		if (code.trim()) {
			segments.push({
				type: 'code',
				content: code.trimEnd(), // Remove trailing whitespace but keep leading
				language: normalizeLanguage(language),
			});
		}

		lastIndex = match.index + match[0].length;
	}

	// Add any remaining text after the last code block
	if (lastIndex < text.length) {
		const remainingText = text.slice(lastIndex);
		if (remainingText.trim()) {
			segments.push({
				type: 'text',
				content: remainingText,
			});
		}
	}

	// If no code blocks were found, return the entire text as a single segment
	if (segments.length === 0 && text.trim()) {
		segments.push({
			type: 'text',
			content: text,
		});
	}

	return segments;
}

/**
 * ResponseViewer component
 *
 * Renders a full-screen modal overlay for viewing complete AI responses.
 * Supports swipe-down gesture to dismiss and swipe left/right to navigate.
 */
export function ResponseViewer({
	isOpen,
	response,
	allResponses,
	currentIndex = 0,
	onNavigate,
	fullText,
	isLoading = false,
	onClose,
	sessionName,
}: ResponseViewerProps) {
	const colors = useThemeColors();
	const { isDark } = useTheme();
	const contentRef = useRef<HTMLDivElement>(null);
	// Vertical swipe state (for dismiss)
	const [touchStartY, setTouchStartY] = useState<number | null>(null);
	const [touchDeltaY, setTouchDeltaY] = useState(0);
	const [isDraggingY, setIsDraggingY] = useState(false);
	// Horizontal swipe state (for navigation)
	const [touchStartX, setTouchStartX] = useState<number | null>(null);
	const [touchDeltaX, setTouchDeltaX] = useState(0);
	const [isDraggingX, setIsDraggingX] = useState(false);
	const [swipeDirection, setSwipeDirection] = useState<'horizontal' | 'vertical' | null>(null);
	// Track which code block was recently copied (by index) for visual feedback
	const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
	// Pinch-to-zoom state
	const [zoomScale, setZoomScale] = useState(1);
	const [isPinching, setIsPinching] = useState(false);
	const [initialPinchDistance, setInitialPinchDistance] = useState<number | null>(null);
	const [initialZoomScale, setInitialZoomScale] = useState(1);
	// Transform origin for zoom (center of pinch gesture)
	const [transformOrigin, setTransformOrigin] = useState({ x: 50, y: 50 });
	// Ref for the zoomable content area
	const zoomableRef = useRef<HTMLDivElement>(null);

	// Determine if navigation is enabled
	const canNavigate = allResponses && allResponses.length > 1 && onNavigate;
	const canGoLeft = canNavigate && currentIndex > 0;
	const canGoRight = canNavigate && currentIndex < allResponses.length - 1;

	// Get the active response (from allResponses if available, otherwise from response prop)
	const activeResponse = useMemo(() => {
		if (
			allResponses &&
			allResponses.length > 0 &&
			currentIndex >= 0 &&
			currentIndex < allResponses.length
		) {
			return allResponses[currentIndex].response;
		}
		return response;
	}, [allResponses, currentIndex, response]);

	// Get the active session name
	const activeSessionName = useMemo(() => {
		if (
			allResponses &&
			allResponses.length > 0 &&
			currentIndex >= 0 &&
			currentIndex < allResponses.length
		) {
			return allResponses[currentIndex].sessionName;
		}
		return sessionName;
	}, [allResponses, currentIndex, sessionName]);

	// Copy code block content to clipboard
	const copyCodeBlock = useCallback(async (content: string, index: number) => {
		try {
			await navigator.clipboard.writeText(content);
			setCopiedIndex(index);
			triggerHaptic(HAPTIC_PATTERNS.success);
			// Reset the copied state after 2 seconds
			setTimeout(() => {
				setCopiedIndex((current) => (current === index ? null : current));
			}, 2000);
		} catch (err) {
			webLogger.error('Failed to copy code', 'ResponseViewer', err);
			triggerHaptic(HAPTIC_PATTERNS.error);
		}
	}, []);

	// Select syntax highlighting style based on theme mode
	const syntaxStyle = isDark ? vscDarkPlus : vs;

	// Threshold for swipe-to-dismiss (pixels)
	const DISMISS_THRESHOLD = 100;
	// Threshold for swipe navigation (pixels)
	const NAVIGATE_THRESHOLD = 80;
	// Minimum movement to determine swipe direction
	const DIRECTION_THRESHOLD = 10;
	// Zoom constraints
	const MIN_ZOOM = 1;
	const MAX_ZOOM = 3;

	// Helper function to calculate distance between two touch points
	const getTouchDistance = useCallback((touches: React.TouchList): number => {
		if (touches.length < 2) return 0;
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}, []);

	// Helper function to get center point of two touches relative to content area
	const getTouchCenter = useCallback(
		(touches: React.TouchList): { x: number; y: number } | null => {
			if (touches.length < 2 || !zoomableRef.current) return null;
			const rect = zoomableRef.current.getBoundingClientRect();
			const centerX = (touches[0].clientX + touches[1].clientX) / 2;
			const centerY = (touches[0].clientY + touches[1].clientY) / 2;
			// Convert to percentage relative to the content area
			const x = ((centerX - rect.left) / rect.width) * 100;
			const y = ((centerY - rect.top) / rect.height) * 100;
			return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
		},
		[]
	);

	// Handle touch start for swipe gestures
	const handleTouchStart = useCallback(
		(e: React.TouchEvent) => {
			// Check for pinch gesture (two fingers)
			if (e.touches.length === 2) {
				const distance = getTouchDistance(e.touches);
				const center = getTouchCenter(e.touches);
				setInitialPinchDistance(distance);
				setInitialZoomScale(zoomScale);
				setIsPinching(true);
				if (center) {
					setTransformOrigin(center);
				}
				// Cancel any swipe gestures
				setIsDraggingX(false);
				setIsDraggingY(false);
				setSwipeDirection(null);
				return;
			}

			// Single finger touch - swipe gestures
			const touch = e.touches[0];
			setTouchStartX(touch.clientX);
			setTouchStartY(touch.clientY);
			setSwipeDirection(null);

			// Only enable vertical dismiss if at top of content and not zoomed in
			if (contentRef.current && contentRef.current.scrollTop === 0 && zoomScale === 1) {
				setIsDraggingY(true);
			}

			// Only enable horizontal navigation if not zoomed in
			if (canNavigate && zoomScale === 1) {
				setIsDraggingX(true);
			}
		},
		[canNavigate, getTouchDistance, getTouchCenter, zoomScale]
	);

	// Handle touch move for swipe gestures
	const handleTouchMove = useCallback(
		(e: React.TouchEvent) => {
			// Handle pinch-to-zoom
			if (isPinching && e.touches.length === 2 && initialPinchDistance !== null) {
				const currentDistance = getTouchDistance(e.touches);
				const scale = (currentDistance / initialPinchDistance) * initialZoomScale;
				const clampedScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
				setZoomScale(clampedScale);
				e.preventDefault();
				return;
			}

			// If pinching started but only one finger remains, ignore
			if (isPinching) return;

			if (touchStartX === null || touchStartY === null) return;

			const touch = e.touches[0];
			const deltaX = touch.clientX - touchStartX;
			const deltaY = touch.clientY - touchStartY;

			// Determine swipe direction if not already set
			if (swipeDirection === null) {
				const absX = Math.abs(deltaX);
				const absY = Math.abs(deltaY);

				if (absX > DIRECTION_THRESHOLD || absY > DIRECTION_THRESHOLD) {
					if (absX > absY && isDraggingX && canNavigate) {
						setSwipeDirection('horizontal');
						setIsDraggingY(false);
					} else if (absY > absX && isDraggingY) {
						setSwipeDirection('vertical');
						setIsDraggingX(false);
					}
				}
			}

			// Handle horizontal swipe for navigation
			if (swipeDirection === 'horizontal' && isDraggingX) {
				// Limit swipe if can't go in that direction
				let constrainedDeltaX = deltaX;
				if (deltaX > 0 && !canGoLeft) {
					constrainedDeltaX = Math.min(deltaX, 50); // Elastic resistance
				} else if (deltaX < 0 && !canGoRight) {
					constrainedDeltaX = Math.max(deltaX, -50); // Elastic resistance
				}
				setTouchDeltaX(constrainedDeltaX);
				e.preventDefault();
			}

			// Handle vertical swipe for dismiss
			if (swipeDirection === 'vertical' && isDraggingY && deltaY > 0) {
				setTouchDeltaY(deltaY);
				e.preventDefault();
			}
		},
		[
			touchStartX,
			touchStartY,
			swipeDirection,
			isDraggingX,
			isDraggingY,
			canNavigate,
			canGoLeft,
			canGoRight,
			isPinching,
			initialPinchDistance,
			initialZoomScale,
			getTouchDistance,
		]
	);

	// Handle touch end for swipe gestures
	const handleTouchEnd = useCallback(() => {
		// Handle pinch end
		if (isPinching) {
			setIsPinching(false);
			setInitialPinchDistance(null);
			// If zoomed out below 1, snap back to 1
			if (zoomScale < 1) {
				setZoomScale(1);
			}
			// Haptic feedback when zoom changes significantly
			if (zoomScale !== initialZoomScale) {
				triggerHaptic(HAPTIC_PATTERNS.tap);
			}
			return;
		}

		// Handle vertical swipe (dismiss)
		if (swipeDirection === 'vertical' && touchDeltaY > DISMISS_THRESHOLD) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onClose();
		}

		// Handle horizontal swipe (navigation)
		if (swipeDirection === 'horizontal' && canNavigate && onNavigate) {
			if (touchDeltaX > NAVIGATE_THRESHOLD && canGoLeft) {
				// Swipe right to go to previous response
				triggerHaptic(HAPTIC_PATTERNS.tap);
				onNavigate(currentIndex - 1);
			} else if (touchDeltaX < -NAVIGATE_THRESHOLD && canGoRight) {
				// Swipe left to go to next response
				triggerHaptic(HAPTIC_PATTERNS.tap);
				onNavigate(currentIndex + 1);
			}
		}

		// Reset all touch state
		setTouchStartX(null);
		setTouchStartY(null);
		setTouchDeltaX(0);
		setTouchDeltaY(0);
		setIsDraggingX(false);
		setIsDraggingY(false);
		setSwipeDirection(null);
	}, [
		swipeDirection,
		touchDeltaY,
		touchDeltaX,
		onClose,
		canNavigate,
		onNavigate,
		currentIndex,
		canGoLeft,
		canGoRight,
		isPinching,
		zoomScale,
		initialZoomScale,
	]);

	// Handle keyboard navigation (Escape to close, Arrow keys to navigate)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!isOpen) return;

			if (e.key === 'Escape') {
				onClose();
			} else if (e.key === 'ArrowLeft' && canGoLeft && onNavigate) {
				triggerHaptic(HAPTIC_PATTERNS.tap);
				onNavigate(currentIndex - 1);
			} else if (e.key === 'ArrowRight' && canGoRight && onNavigate) {
				triggerHaptic(HAPTIC_PATTERNS.tap);
				onNavigate(currentIndex + 1);
			}
		};

		if (isOpen) {
			document.addEventListener('keydown', handleKeyDown);
			// Prevent body scroll when modal is open
			document.body.style.overflow = 'hidden';
		}

		return () => {
			document.removeEventListener('keydown', handleKeyDown);
			document.body.style.overflow = '';
		};
	}, [isOpen, onClose, canGoLeft, canGoRight, onNavigate, currentIndex]);

	// Reset zoom when navigating to a different response
	useEffect(() => {
		setZoomScale(1);
		setTransformOrigin({ x: 50, y: 50 });
	}, [currentIndex]);

	// Reset zoom when closing
	useEffect(() => {
		if (!isOpen) {
			setZoomScale(1);
			setTransformOrigin({ x: 50, y: 50 });
		}
	}, [isOpen]);

	// Double tap to reset zoom
	const lastTapRef = useRef<number>(0);
	const handleDoubleTap = useCallback(
		(e: React.TouchEvent) => {
			// Only handle single finger taps
			if (e.touches.length !== 1) return;

			const now = Date.now();
			const timeSinceLastTap = now - lastTapRef.current;

			if (timeSinceLastTap < 300) {
				// Double tap detected
				if (zoomScale > 1) {
					// Reset to normal
					setZoomScale(1);
					setTransformOrigin({ x: 50, y: 50 });
					triggerHaptic(HAPTIC_PATTERNS.tap);
				} else {
					// Zoom in to 2x at tap location
					const touch = e.touches[0];
					if (zoomableRef.current) {
						const rect = zoomableRef.current.getBoundingClientRect();
						const x = ((touch.clientX - rect.left) / rect.width) * 100;
						const y = ((touch.clientY - rect.top) / rect.height) * 100;
						setTransformOrigin({ x, y });
					}
					setZoomScale(2);
					triggerHaptic(HAPTIC_PATTERNS.tap);
				}
				lastTapRef.current = 0;
			} else {
				lastTapRef.current = now;
			}
		},
		[zoomScale]
	);

	// Don't render if not open
	if (!isOpen || (!response && !activeResponse)) {
		return null;
	}

	// Use the active response for display
	const displayResponse = activeResponse || response;
	if (!displayResponse) {
		return null;
	}

	// Display text - use full text if available, otherwise preview
	// Strip ANSI codes since web interface doesn't render terminal colors
	const rawDisplayText = fullText || displayResponse.text;
	const displayText = stripAnsiCodes(rawDisplayText);
	const hasMoreContent = !fullText && displayResponse.fullLength > displayResponse.text.length;

	// Parse the display text to extract code blocks for syntax highlighting
	const parsedSegments = parseTextWithCodeBlocks(displayText);

	// Calculate opacity based on swipe progress (vertical for dismiss)
	const backdropOpacity = Math.max(0, 1 - touchDeltaY / (DISMISS_THRESHOLD * 2));

	// Determine if currently swiping
	const isSwipingVertical = swipeDirection === 'vertical' && isDraggingY;
	const isSwipingHorizontal = swipeDirection === 'horizontal' && isDraggingX;
	const isAnySwipe = isSwipingVertical || isSwipingHorizontal;

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: 1000,
				display: 'flex',
				flexDirection: 'column',
				backgroundColor: `rgba(0, 0, 0, ${0.9 * backdropOpacity})`,
				transform: `translate(${touchDeltaX}px, ${touchDeltaY}px)`,
				transition: isAnySwipe ? 'none' : 'transform 0.3s ease-out, background-color 0.3s ease-out',
			}}
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			aria-modal="true"
			role="dialog"
			aria-label="Full response viewer"
		>
			{/* Header bar */}
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '12px 16px',
					paddingTop: 'max(12px, env(safe-area-inset-top))',
					backgroundColor: colors.bgSidebar,
					borderBottom: `1px solid ${colors.border}`,
					minHeight: '56px',
					flexShrink: 0,
				}}
			>
				{/* Left side: Title and session info */}
				<div style={{ flex: 1, minWidth: 0 }}>
					<h2
						style={{
							fontSize: '16px',
							fontWeight: 600,
							color: colors.textMain,
							margin: 0,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						Response
					</h2>
					<div
						style={{
							fontSize: '12px',
							color: colors.textDim,
							marginTop: '2px',
							display: 'flex',
							alignItems: 'center',
							gap: '8px',
						}}
					>
						{activeSessionName && (
							<span
								style={{
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								}}
							>
								{activeSessionName}
							</span>
						)}
						<span style={{ opacity: 0.7 }}>{formatTimestamp(displayResponse.timestamp)}</span>
					</div>
				</div>

				{/* Right side: Close button */}
				<button
					onClick={() => {
						triggerHaptic(HAPTIC_PATTERNS.tap);
						onClose();
					}}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '36px',
						height: '36px',
						borderRadius: '50%',
						backgroundColor: `${colors.textDim}20`,
						border: 'none',
						cursor: 'pointer',
						color: colors.textMain,
						fontSize: '18px',
						fontWeight: 500,
						marginLeft: '12px',
						flexShrink: 0,
					}}
					aria-label="Close response viewer"
				>
					×
				</button>
			</header>

			{/* Swipe indicator */}
			<div
				style={{
					display: 'flex',
					justifyContent: 'center',
					padding: '8px 0',
					backgroundColor: colors.bgMain,
				}}
			>
				<div
					style={{
						width: '36px',
						height: '4px',
						borderRadius: '2px',
						backgroundColor: `${colors.textDim}40`,
					}}
					aria-hidden="true"
				/>
			</div>

			{/* Content area */}
			<div
				ref={contentRef}
				style={{
					flex: 1,
					overflow: 'auto',
					padding: '16px',
					backgroundColor: colors.bgMain,
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{isLoading ? (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							height: '100%',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						Loading full response...
					</div>
				) : (
					<>
						{/* Zoom indicator when zoomed in */}
						{zoomScale > 1 && (
							<div
								style={{
									position: 'sticky',
									top: 0,
									right: 0,
									zIndex: 10,
									display: 'flex',
									justifyContent: 'flex-end',
									marginBottom: '8px',
								}}
							>
								<button
									onClick={() => {
										setZoomScale(1);
										setTransformOrigin({ x: 50, y: 50 });
										triggerHaptic(HAPTIC_PATTERNS.tap);
									}}
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: '4px',
										padding: '6px 10px',
										borderRadius: '16px',
										backgroundColor: `${colors.accent}20`,
										border: `1px solid ${colors.accent}40`,
										color: colors.accent,
										fontSize: '11px',
										fontWeight: 500,
										cursor: 'pointer',
									}}
									aria-label="Reset zoom"
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<circle cx="11" cy="11" r="8" />
										<line x1="21" y1="21" x2="16.65" y2="16.65" />
										<line x1="8" y1="11" x2="14" y2="11" />
									</svg>
									{Math.round(zoomScale * 100)}%
								</button>
							</div>
						)}
						{/* Response content with syntax-highlighted code blocks */}
						<div
							ref={zoomableRef}
							onTouchStart={handleDoubleTap}
							style={{
								display: 'flex',
								flexDirection: 'column',
								gap: '12px',
								transform: `scale(${zoomScale})`,
								transformOrigin: `${transformOrigin.x}% ${transformOrigin.y}%`,
								transition: isPinching ? 'none' : 'transform 0.2s ease-out',
								touchAction: zoomScale > 1 ? 'pan-x pan-y' : 'auto',
							}}
						>
							{parsedSegments.map((segment, index) => {
								if (segment.type === 'code') {
									const isCopied = copiedIndex === index;
									return (
										<div
											key={index}
											style={{
												borderRadius: '8px',
												overflow: 'hidden',
												border: `1px solid ${colors.border}`,
											}}
										>
											{/* Code block header with language label and copy button */}
											<div
												style={{
													display: 'flex',
													alignItems: 'center',
													justifyContent: 'space-between',
													padding: '4px 8px 4px 12px',
													backgroundColor: colors.bgActivity,
													borderBottom: `1px solid ${colors.border}`,
													minHeight: '28px',
												}}
											>
												{/* Language label */}
												<span
													style={{
														fontSize: '11px',
														fontWeight: 500,
														color: colors.textDim,
														textTransform: 'uppercase',
														letterSpacing: '0.5px',
													}}
												>
													{segment.language && segment.language !== 'text'
														? segment.language
														: 'code'}
												</span>
												{/* Copy button */}
												<button
													onClick={() => copyCodeBlock(segment.content, index)}
													style={{
														display: 'flex',
														alignItems: 'center',
														gap: '4px',
														padding: '4px 8px',
														borderRadius: '4px',
														border: 'none',
														backgroundColor: isCopied ? `${colors.success}20` : 'transparent',
														color: isCopied ? colors.success : colors.textDim,
														fontSize: '11px',
														fontWeight: 500,
														cursor: 'pointer',
														transition: 'all 0.2s ease',
													}}
													aria-label={isCopied ? 'Copied!' : 'Copy code'}
												>
													{isCopied ? (
														<>
															<svg
																width="14"
																height="14"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																strokeWidth="2"
																strokeLinecap="round"
																strokeLinejoin="round"
															>
																<polyline points="20 6 9 17 4 12" />
															</svg>
															Copied
														</>
													) : (
														<>
															<svg
																width="14"
																height="14"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																strokeWidth="2"
																strokeLinecap="round"
																strokeLinejoin="round"
															>
																<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
																<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
															</svg>
															Copy
														</>
													)}
												</button>
											</div>
											<SyntaxHighlighter
												language={segment.language || 'text'}
												style={syntaxStyle}
												customStyle={{
													margin: 0,
													padding: '12px',
													fontSize: '12px',
													lineHeight: 1.5,
													backgroundColor: colors.bgActivity,
													borderRadius: 0,
												}}
												wrapLongLines={true}
												showLineNumbers={false}
											>
												{segment.content}
											</SyntaxHighlighter>
										</div>
									);
								}

								// Regular text segment
								return (
									<div
										key={index}
										style={{
											fontFamily:
												'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
											fontSize: '13px',
											lineHeight: 1.6,
											color: colors.textMain,
											whiteSpace: 'pre-wrap',
											wordBreak: 'break-word',
										}}
									>
										{segment.content}
									</div>
								);
							})}
						</div>

						{/* Truncation notice */}
						{hasMoreContent && (
							<div
								style={{
									marginTop: '16px',
									padding: '12px',
									borderRadius: '8px',
									backgroundColor: `${colors.warning}15`,
									border: `1px solid ${colors.warning}30`,
									color: colors.textDim,
									fontSize: '12px',
									textAlign: 'center',
								}}
							>
								Showing preview ({displayResponse.text.length} of {displayResponse.fullLength}{' '}
								characters).
								<br />
								Full response loading not available.
							</div>
						)}
					</>
				)}
			</div>

			{/* Footer with safe area padding */}
			<footer
				style={{
					padding: '12px 16px',
					paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
					backgroundColor: colors.bgSidebar,
					borderTop: `1px solid ${colors.border}`,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					gap: '8px',
					flexShrink: 0,
				}}
			>
				{/* Pagination dots when navigation is available */}
				{canNavigate && allResponses && (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							gap: '6px',
						}}
						aria-label={`Response ${currentIndex + 1} of ${allResponses.length}`}
					>
						{allResponses.map((_, index) => (
							<button
								key={index}
								onClick={() => {
									if (onNavigate) {
										triggerHaptic(HAPTIC_PATTERNS.tap);
										onNavigate(index);
									}
								}}
								style={{
									width: index === currentIndex ? '16px' : '8px',
									height: '8px',
									borderRadius: '4px',
									backgroundColor: index === currentIndex ? colors.accent : `${colors.textDim}40`,
									border: 'none',
									padding: 0,
									cursor: 'pointer',
									transition: 'all 0.2s ease',
								}}
								aria-label={`Go to response ${index + 1}`}
								aria-current={index === currentIndex ? 'true' : undefined}
							/>
						))}
					</div>
				)}

				{/* Navigation hint text */}
				<span
					style={{
						fontSize: '11px',
						color: colors.textDim,
						textAlign: 'center',
					}}
				>
					{zoomScale > 1
						? 'Double-tap or tap reset to zoom out'
						: canNavigate
							? 'Pinch to zoom • Swipe left/right to navigate • Swipe down to dismiss'
							: 'Pinch to zoom • Swipe down to dismiss'}
				</span>
			</footer>
		</div>
	);
}

export default ResponseViewer;
