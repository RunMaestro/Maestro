/**
 * AutoRunPanel component for Maestro mobile web interface
 *
 * Full-screen management panel for Auto Run documents.
 * Provides document listing, launch/stop controls, and navigation
 * to document viewer and setup sheet.
 */

import { useState, useCallback, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { useAutoRun } from '../hooks/useAutoRun';
import { DocumentCard } from './AutoRunDocumentCard';
import type { AutoRunState, UseWebSocketReturn } from '../hooks/useWebSocket';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

/**
 * Props for AutoRunPanel component
 */
export interface AutoRunPanelProps {
	sessionId: string;
	autoRunState: AutoRunState | null;
	onClose: () => void;
	onOpenDocument?: (filename: string) => void;
	onOpenSetup?: () => void;
	sendRequest: UseWebSocketReturn['sendRequest'];
	send: UseWebSocketReturn['send'];
}

/**
 * AutoRunPanel component
 *
 * Full-screen panel for managing Auto Run documents, launching/stopping runs,
 * and navigating to document viewer and setup sheet.
 */
export function AutoRunPanel({
	sessionId,
	autoRunState,
	onClose,
	onOpenDocument,
	onOpenSetup,
	sendRequest,
	send,
}: AutoRunPanelProps) {
	const colors = useThemeColors();
	const [isStopping, setIsStopping] = useState(false);

	const { documents, isLoadingDocs, loadDocuments, stopAutoRun } = useAutoRun(
		sendRequest,
		send,
		autoRunState
	);

	// Load documents on mount and when sessionId changes
	useEffect(() => {
		loadDocuments(sessionId);
	}, [sessionId, loadDocuments]);

	// Reset stopping state when autoRun stops
	useEffect(() => {
		if (!autoRunState?.isRunning) {
			setIsStopping(false);
		}
	}, [autoRunState?.isRunning]);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClose();
	}, [onClose]);

	const handleRefresh = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		loadDocuments(sessionId);
	}, [sessionId, loadDocuments]);

	const handleStop = useCallback(async () => {
		triggerHaptic(HAPTIC_PATTERNS.interrupt);
		setIsStopping(true);
		const success = await stopAutoRun(sessionId);
		if (!success) {
			setIsStopping(false);
		}
	}, [sessionId, stopAutoRun]);

	const handleConfigure = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onOpenSetup?.();
	}, [onOpenSetup]);

	const handleDocumentTap = useCallback(
		(filename: string) => {
			onOpenDocument?.(filename);
		},
		[onOpenDocument]
	);

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	const isRunning = autoRunState?.isRunning ?? false;
	const totalTasks = autoRunState?.totalTasks;
	const completedTasks = autoRunState?.completedTasks ?? 0;
	const currentTaskIndex = autoRunState?.currentTaskIndex ?? 0;
	const progress =
		totalTasks != null && totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
	const totalDocs = autoRunState?.totalDocuments;
	const currentDocIndex = autoRunState?.currentDocumentIndex;

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 200,
				display: 'flex',
				flexDirection: 'column',
				animation: 'autoRunSlideUp 0.25s ease-out',
			}}
		>
			{/* Header */}
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '12px 16px',
					paddingTop: 'max(12px, env(safe-area-inset-top))',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
					minHeight: '56px',
					flexShrink: 0,
				}}
			>
				<h1
					style={{
						fontSize: '18px',
						fontWeight: 600,
						margin: 0,
						color: colors.textMain,
					}}
				>
					Auto Run
				</h1>

				<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
					{/* Refresh button */}
					<button
						onClick={handleRefresh}
						style={{
							width: '44px',
							height: '44px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgMain,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Refresh documents"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
						</svg>
					</button>

					{/* Close button */}
					<button
						onClick={handleClose}
						style={{
							width: '44px',
							height: '44px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgMain,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Close Auto Run panel"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			</header>

			{/* Status bar (when running) */}
			{isRunning && (
				<div
					style={{
						backgroundColor:
							isStopping || autoRunState?.isStopping ? colors.warning : colors.accent,
						padding: '12px 16px',
						display: 'flex',
						alignItems: 'center',
						gap: '12px',
						flexShrink: 0,
					}}
				>
					{/* Progress badge */}
					<div
						style={{
							fontSize: '14px',
							fontWeight: 700,
							color: isStopping || autoRunState?.isStopping ? colors.warning : colors.accent,
							backgroundColor: 'white',
							padding: '6px 12px',
							borderRadius: '16px',
							flexShrink: 0,
						}}
					>
						{progress}%
					</div>

					{/* Status text */}
					<div style={{ flex: 1, minWidth: 0 }}>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '12px',
								fontSize: '13px',
								color: 'white',
								fontWeight: 500,
							}}
						>
							{totalTasks != null && totalTasks > 0 && (
								<span>
									Task {currentTaskIndex + 1}/{totalTasks}
								</span>
							)}
							{totalDocs != null && currentDocIndex != null && totalDocs > 1 && (
								<span>
									Doc {currentDocIndex + 1}/{totalDocs}
								</span>
							)}
						</div>

						{/* Progress bar */}
						<div
							style={{
								height: '4px',
								backgroundColor: 'rgba(255,255,255,0.3)',
								borderRadius: '2px',
								marginTop: '6px',
								overflow: 'hidden',
							}}
						>
							<div
								style={{
									width: `${progress}%`,
									height: '100%',
									backgroundColor: 'white',
									borderRadius: '2px',
									transition: 'width 0.3s ease-out',
								}}
							/>
						</div>
					</div>
				</div>
			)}

			{/* Controls bar */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '10px',
					padding: '12px 16px',
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				{/* Configure & Launch button */}
				<button
					onClick={handleConfigure}
					disabled={isRunning}
					style={{
						flex: 1,
						padding: '12px 16px',
						borderRadius: '10px',
						backgroundColor: isRunning ? `${colors.accent}40` : colors.accent,
						border: 'none',
						color: 'white',
						fontSize: '14px',
						fontWeight: 600,
						cursor: isRunning ? 'not-allowed' : 'pointer',
						opacity: isRunning ? 0.5 : 1,
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						minHeight: '44px',
					}}
					aria-label="Configure and launch Auto Run"
				>
					Configure & Launch
				</button>

				{/* Stop button (visible only when running) */}
				{isRunning && (
					<button
						onClick={handleStop}
						disabled={isStopping || autoRunState?.isStopping}
						style={{
							padding: '12px 20px',
							borderRadius: '10px',
							backgroundColor:
								isStopping || autoRunState?.isStopping ? `${colors.error}60` : colors.error,
							border: 'none',
							color: 'white',
							fontSize: '14px',
							fontWeight: 600,
							cursor: isStopping || autoRunState?.isStopping ? 'not-allowed' : 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							minHeight: '44px',
							flexShrink: 0,
						}}
						aria-label={
							isStopping || autoRunState?.isStopping ? 'Stopping Auto Run' : 'Stop Auto Run'
						}
					>
						{isStopping || autoRunState?.isStopping ? 'Stopping...' : 'Stop'}
					</button>
				)}
			</div>

			{/* Document list */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					overflowX: 'hidden',
					padding: '16px',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{isLoadingDocs ? (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px 20px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						Loading documents...
					</div>
				) : documents.length === 0 ? (
					/* Empty state */
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px 20px',
							textAlign: 'center',
						}}
					>
						<p style={{ fontSize: '15px', color: colors.textMain, marginBottom: '8px' }}>
							No Auto Run documents found
						</p>
						<p style={{ fontSize: '13px', color: colors.textDim }}>
							Create documents in the{' '}
							<code
								style={{
									fontSize: '12px',
									backgroundColor: `${colors.textDim}15`,
									padding: '2px 4px',
									borderRadius: '3px',
								}}
							>
								.maestro/playbooks/
							</code>{' '}
							directory to get started
						</p>
					</div>
				) : (
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							gap: '10px',
						}}
					>
						{documents.map((doc) => (
							<DocumentCard key={doc.filename} document={doc} onTap={handleDocumentTap} />
						))}
					</div>
				)}
			</div>

			{/* Animation keyframes */}
			<style>{`
				@keyframes autoRunSlideUp {
					from {
						opacity: 0;
						transform: translateY(20px);
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

export default AutoRunPanel;
