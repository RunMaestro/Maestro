/**
 * AutoRunPanel component for Maestro mobile web interface
 *
 * Full-screen Auto Run management view that mirrors the desktop AutoRun panel.
 * Reuses {@link AutoRunInline} so the layout, toolbar, document selector,
 * preview/edit, search, and footer match the desktop and the inline tab in
 * `RightDrawer` exactly. The full-screen wrapper just adds a header bar with
 * back/close affordances and a slide-in animation.
 */

import { useCallback, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { AutoRunInline } from './AutoRunInline';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { AutoRunState, UseWebSocketReturn } from '../hooks/useWebSocket';

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
	/** Optional: hook the recovery actions on the inline error banner. */
	onResumeAfterError?: () => Promise<unknown> | void;
	onSkipAfterError?: () => Promise<unknown> | void;
	onAbortAfterError?: () => Promise<unknown> | void;
	/** Bubble selection changes up so the launch sheet can pre-fill the active doc. */
	onSelectedDocumentChange?: (filename: string | null) => void;
	/** Open the server-driven folder picker (desktop parity for `dialog.selectFolder`). */
	onOpenFolderPicker?: () => void;
}

/**
 * AutoRunPanel — full-screen wrapper around {@link AutoRunInline}.
 */
export function AutoRunPanel({
	sessionId,
	autoRunState,
	onClose,
	onOpenDocument,
	onOpenSetup,
	sendRequest,
	send,
	onResumeAfterError,
	onSkipAfterError,
	onAbortAfterError,
	onSelectedDocumentChange,
	onOpenFolderPicker,
}: AutoRunPanelProps) {
	const colors = useThemeColors();

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClose();
	}, [onClose]);

	const handleOpenSetup = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onOpenSetup?.();
	}, [onOpenSetup]);

	// Close on Escape — but only when no nested overlay is intercepting the key.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				// Let nested dialogs (help sheet, create-doc sheet, search bar)
				// handle Escape first; AutoRunInline closes them on its own and the
				// remaining presses bubble out here to close the whole panel.
				const target = e.target as HTMLElement | null;
				if (target?.closest('[role="dialog"]')) return;
				onClose();
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [onClose]);

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
			</header>

			{/* Inline panel — same component used by the right-drawer Auto Run tab */}
			<div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
				<AutoRunInline
					sessionId={sessionId}
					autoRunState={autoRunState}
					sendRequest={sendRequest}
					send={send}
					onOpenSetup={handleOpenSetup}
					onExpandDocument={onOpenDocument}
					onResumeAfterError={onResumeAfterError}
					onSkipAfterError={onSkipAfterError}
					onAbortAfterError={onAbortAfterError}
					onSelectedDocumentChange={onSelectedDocumentChange}
					onOpenFolderPicker={onOpenFolderPicker}
				/>
			</div>

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
