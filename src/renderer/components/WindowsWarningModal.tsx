/**
 * WindowsWarningModal - Notifies Windows users about platform-specific considerations
 *
 * This modal is shown on application startup for Windows users to:
 * - Inform them that Windows support is newer and may have more bugs
 * - Encourage opting into the beta channel for latest fixes
 * - Provide easy access to issue reporting with Debug Package creation
 * - Allow users to suppress this message for future sessions
 */

import React, { useState, useRef, useCallback } from 'react';
import {
	AlertTriangle,
	Bug,
	Wrench,
	ExternalLink,
	Command,
	Check,
	MessageCircle,
} from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface WindowsWarningModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onSuppressFuture: (suppress: boolean) => void;
	onOpenDebugPackage: () => void;
	useBetaChannel: boolean;
	onSetUseBetaChannel: (enabled: boolean) => void;
}

export function WindowsWarningModal({
	theme,
	isOpen,
	onClose,
	onSuppressFuture,
	onOpenDebugPackage,
	useBetaChannel,
	onSetUseBetaChannel,
}: WindowsWarningModalProps) {
	const [suppressChecked, setSuppressChecked] = useState(false);
	const continueButtonRef = useRef<HTMLButtonElement>(null);

	// Handle close with suppress preference
	const handleClose = useCallback(() => {
		onSuppressFuture(suppressChecked);
		onClose();
	}, [suppressChecked, onSuppressFuture, onClose]);

	// Handle toggling beta channel
	const handleToggleBetaChannel = useCallback(() => {
		onSetUseBetaChannel(!useBetaChannel);
	}, [useBetaChannel, onSetUseBetaChannel]);

	// Handle opening debug package modal
	const handleOpenDebugPackage = useCallback(() => {
		onSuppressFuture(suppressChecked);
		onOpenDebugPackage();
		onClose();
	}, [suppressChecked, onSuppressFuture, onOpenDebugPackage, onClose]);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Windows Support Notice"
			headerIcon={<AlertTriangle className="w-4 h-4" style={{ color: theme.colors.warning }} />}
			priority={MODAL_PRIORITIES.WINDOWS_WARNING}
			onClose={handleClose}
			width={520}
			initialFocusRef={continueButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={handleClose}
					onConfirm={handleClose}
					cancelLabel="Cancel"
					confirmLabel="Got it!"
					confirmButtonRef={continueButtonRef}
					showCancel={false}
				/>
			}
		>
			<div className="space-y-4">
				{/* Main message */}
				<div
					className="p-4 rounded-lg border-l-4"
					style={{
						backgroundColor: `${theme.colors.warning}10`,
						borderLeftColor: theme.colors.warning,
					}}
				>
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
						Windows support in Maestro is actively being improved. You may encounter more bugs
						compared to Mac and Linux versions. We're working on it!
					</p>
				</div>

				{/* Recommendations */}
				<div className="space-y-3">
					<h3
						className="text-xs font-semibold uppercase tracking-wider"
						style={{ color: theme.colors.textDim }}
					>
						Recommendations
					</h3>

					{/* Beta channel toggle */}
					<button
						type="button"
						onClick={handleToggleBetaChannel}
						className="w-full flex items-start gap-3 p-3 rounded-lg border hover:bg-white/5 transition-colors text-left"
						style={{
							borderColor: useBetaChannel ? theme.colors.accent : theme.colors.border,
							backgroundColor: useBetaChannel ? `${theme.colors.accent}10` : 'transparent',
						}}
					>
						<Wrench className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.accent }} />
						<div className="flex-1 min-w-0">
							<p className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Enable Beta Updates
							</p>
							<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Get the latest bug fixes sooner by opting into the beta channel.
							</p>
						</div>
						{/* Toggle indicator */}
						<div
							className="w-10 h-5 rounded-full shrink-0 mt-0.5 transition-colors relative"
							style={{
								backgroundColor: useBetaChannel ? theme.colors.accent : theme.colors.bgMain,
								border: `1px solid ${useBetaChannel ? theme.colors.accent : theme.colors.border}`,
							}}
						>
							<div
								className="absolute w-3.5 h-3.5 rounded-full top-0.5 transition-all flex items-center justify-center"
								style={{
									backgroundColor: useBetaChannel
										? theme.colors.accentForeground
										: theme.colors.textDim,
									left: useBetaChannel ? 'calc(100% - 18px)' : '2px',
								}}
							>
								{useBetaChannel && (
									<Check className="w-2 h-2" style={{ color: theme.colors.accent }} />
								)}
							</div>
						</div>
					</button>

					{/* Report issues */}
					<button
						type="button"
						onClick={() =>
							window.maestro.shell.openExternal('https://github.com/pedramamini/Maestro/issues')
						}
						className="w-full flex items-start gap-3 p-3 rounded-lg border hover:bg-white/5 transition-colors text-left"
						style={{ borderColor: theme.colors.border }}
					>
						<Bug className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.accent }} />
						<div className="flex-1 min-w-0">
							<p className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Report Issues
							</p>
							<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Help improve Windows support by reporting bugs on GitHub. Vetted PRs are welcome!
							</p>
						</div>
						<ExternalLink
							className="w-3 h-3 shrink-0 mt-1"
							style={{ color: theme.colors.textDim }}
						/>
					</button>

					{/* Join Discord */}
					<button
						type="button"
						onClick={() => window.maestro.shell.openExternal('https://discord.gg/FCAh4EWzfD')}
						className="w-full flex items-start gap-3 p-3 rounded-lg border hover:bg-white/5 transition-colors text-left"
						style={{ borderColor: theme.colors.border }}
					>
						<MessageCircle
							className="w-4 h-4 mt-0.5 shrink-0"
							style={{ color: theme.colors.accent }}
						/>
						<div className="flex-1 min-w-0">
							<p className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Join Discord
							</p>
							<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Connect with other users in our Windows-specific channel for tips and support.
							</p>
						</div>
						<ExternalLink
							className="w-3 h-3 shrink-0 mt-1"
							style={{ color: theme.colors.textDim }}
						/>
					</button>

					{/* Create Debug Package */}
					<button
						type="button"
						onClick={handleOpenDebugPackage}
						className="w-full flex items-start gap-3 p-3 rounded-lg border hover:bg-white/5 transition-colors text-left"
						style={{ borderColor: theme.colors.border }}
					>
						<Command className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.accent }} />
						<div className="flex-1 min-w-0">
							<p className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Create Debug Package
							</p>
							<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Accessible anytime via{' '}
								<kbd
									className="px-1 py-0.5 rounded text-[10px]"
									style={{ backgroundColor: theme.colors.bgMain }}
								>
									Ctrl+K
								</kbd>{' '}
								→ "Create Debug Package" or from the main menu.
							</p>
						</div>
						<ExternalLink
							className="w-3 h-3 shrink-0 mt-1"
							style={{ color: theme.colors.textDim }}
						/>
					</button>
				</div>

				{/* Suppress checkbox */}
				<label className="flex items-center gap-2 pt-2 cursor-pointer group">
					<div
						className="w-4 h-4 rounded border flex items-center justify-center transition-colors"
						style={{
							borderColor: suppressChecked ? theme.colors.accent : theme.colors.border,
							backgroundColor: suppressChecked ? theme.colors.accent : 'transparent',
						}}
					>
						{suppressChecked && (
							<svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
								<path
									d="M2 6L5 9L10 3"
									stroke={theme.colors.accentForeground}
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						)}
					</div>
					<input
						type="checkbox"
						checked={suppressChecked}
						onChange={(e) => setSuppressChecked(e.target.checked)}
						className="sr-only"
					/>
					<span
						className="text-xs group-hover:opacity-100 transition-opacity"
						style={{ color: theme.colors.textDim, opacity: 0.8 }}
					>
						Don't show this message again
					</span>
				</label>
			</div>
		</Modal>
	);
}

/**
 * Debug function to show the Windows warning modal from the console.
 * Usage: window.__showWindowsWarningModal()
 */
export function exposeWindowsWarningModalDebug(
	setShowWindowsWarning: (show: boolean) => void
): void {
	(window as any).__showWindowsWarningModal = () => {
		setShowWindowsWarning(true);
		console.log('[WindowsWarningModal] Modal triggered via console command');
	};
}

export default WindowsWarningModal;
