import { memo } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';
import { STATUS_COLORS } from '../helpers/statusInfo';

export interface GhCliStatus {
	installed: boolean;
	authenticated: boolean;
}

export interface BuildToolsWarningDialogProps {
	theme: Theme;
	isOpen: boolean;
	isChecking: boolean;
	ghCliStatus: GhCliStatus | null;
	onConfirm: () => void;
	onClose: () => void;
}

/**
 * Pre-flight check dialog that gates the Symphony "Start Contribution" flow.
 *
 * - When isChecking is true → spinner + "Checking prerequisites…"
 * - When gh is not installed → install instructions + Close button (close-only)
 * - When gh is unauthenticated → auth instructions + Close button (close-only)
 * - When all clear → build-tools warning + "I Have the Build Tools" → onConfirm
 *
 * Rendered through a portal so it sits above the main SymphonyModal.
 */
export const BuildToolsWarningDialog = memo(function BuildToolsWarningDialog({
	theme,
	isOpen,
	isChecking,
	ghCliStatus,
	onConfirm,
	onClose,
}: BuildToolsWarningDialogProps) {
	if (!isOpen) return null;
	const isGhCliReady = Boolean(ghCliStatus?.installed && ghCliStatus.authenticated);
	const dialogTitleId = 'symphony-build-tools-dialog-title';

	const dialog = (
		<div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 10001 }}>
			<button
				type="button"
				className="absolute inset-0"
				style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
				tabIndex={-1}
				onClick={onClose}
				aria-label="Close pre-flight check dialog"
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={dialogTitleId}
				className="relative rounded-lg border shadow-2xl p-6 max-w-md mx-4"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
				}}
			>
				{isChecking ? (
					<div className="flex items-center gap-3 py-4">
						<Spinner size={20} color={theme.colors.textDim} />
						<span id={dialogTitleId} className="text-sm" style={{ color: theme.colors.textDim }}>
							Checking prerequisites…
						</span>
					</div>
				) : ghCliStatus && !ghCliStatus.installed ? (
					<>
						<div className="flex items-start gap-3 mb-4">
							<AlertCircle
								className="w-6 h-6 shrink-0 mt-0.5"
								style={{ color: STATUS_COLORS.failed }}
							/>
							<div>
								<h3
									id={dialogTitleId}
									className="font-semibold text-base mb-2"
									style={{ color: theme.colors.textMain }}
								>
									GitHub CLI Required
								</h3>
								<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
									Symphony requires the GitHub CLI (
									<code
										className="px-1 py-0.5 rounded text-xs"
										style={{
											backgroundColor: `${theme.colors.border}80`,
											color: theme.colors.textMain,
										}}
									>
										gh
									</code>
									) to create draft PRs and manage contributions. It is not currently installed on
									your system.
								</p>
								<p className="text-sm leading-relaxed mt-2" style={{ color: theme.colors.textDim }}>
									Install it from{' '}
									<a
										href="https://cli.github.com/"
										target="_blank"
										rel="noopener noreferrer"
										className="underline"
										style={{ color: theme.colors.accent }}
									>
										cli.github.com
									</a>{' '}
									and run{' '}
									<code
										className="px-1 py-0.5 rounded text-xs"
										style={{
											backgroundColor: `${theme.colors.border}80`,
											color: theme.colors.textMain,
										}}
									>
										gh auth login
									</code>{' '}
									to authenticate.
								</p>
							</div>
						</div>
						<div className="flex justify-end mt-4">
							<button
								onClick={onClose}
								className="px-4 py-2 rounded text-sm transition-colors hover:bg-white/10"
								style={{
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Close
							</button>
						</div>
					</>
				) : ghCliStatus && !ghCliStatus.authenticated ? (
					<>
						<div className="flex items-start gap-3 mb-4">
							<AlertCircle
								className="w-6 h-6 shrink-0 mt-0.5"
								style={{ color: STATUS_COLORS.failed }}
							/>
							<div>
								<h3
									id={dialogTitleId}
									className="font-semibold text-base mb-2"
									style={{ color: theme.colors.textMain }}
								>
									GitHub CLI Not Authenticated
								</h3>
								<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
									The GitHub CLI (
									<code
										className="px-1 py-0.5 rounded text-xs"
										style={{
											backgroundColor: `${theme.colors.border}80`,
											color: theme.colors.textMain,
										}}
									>
										gh
									</code>
									) is installed but not authenticated. Symphony needs GitHub access to create draft
									PRs and manage contributions.
								</p>
								<p className="text-sm leading-relaxed mt-2" style={{ color: theme.colors.textDim }}>
									Run{' '}
									<code
										className="px-1 py-0.5 rounded text-xs"
										style={{
											backgroundColor: `${theme.colors.border}80`,
											color: theme.colors.textMain,
										}}
									>
										gh auth login
									</code>{' '}
									in your terminal to authenticate.
								</p>
							</div>
						</div>
						<div className="flex justify-end mt-4">
							<button
								onClick={onClose}
								className="px-4 py-2 rounded text-sm transition-colors hover:bg-white/10"
								style={{
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Close
							</button>
						</div>
					</>
				) : isGhCliReady ? (
					<>
						<div className="flex items-start gap-3 mb-1">
							<CheckCircle
								className="w-5 h-5 shrink-0 mt-0.5"
								style={{ color: STATUS_COLORS.running }}
							/>
							<span className="text-sm" style={{ color: STATUS_COLORS.running }}>
								GitHub CLI authenticated
							</span>
						</div>
						<div className="flex items-start gap-3 mb-4 mt-3">
							<AlertCircle
								className="w-6 h-6 shrink-0 mt-0.5"
								style={{ color: STATUS_COLORS.paused }}
							/>
							<div>
								<h3
									id={dialogTitleId}
									className="font-semibold text-base mb-2"
									style={{ color: theme.colors.textMain }}
								>
									Build Tools Required
								</h3>
								<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
									Symphony will clone this repository and run Auto Run documents that may compile
									code, run tests, and make changes. Before proceeding, make sure you have the
									project's build tools and dependencies installed on your machine (e.g., Node.js,
									Python, Rust toolchain, etc.).
								</p>
								<p className="text-sm leading-relaxed mt-2" style={{ color: theme.colors.textDim }}>
									Consider cloning the project first and verifying you can build it successfully.
									Without the right toolchain, the contribution is likely to fail.
								</p>
							</div>
						</div>
						<div className="flex justify-end gap-2 mt-4">
							<button
								onClick={onClose}
								className="px-4 py-2 rounded text-sm transition-colors hover:bg-white/10"
								style={{
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Cancel
							</button>
							<button
								onClick={onConfirm}
								className="px-4 py-2 rounded font-semibold text-sm transition-colors"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								I Have the Build Tools
							</button>
						</div>
					</>
				) : (
					<>
						<div className="flex items-start gap-3 mb-4">
							<AlertCircle
								className="w-6 h-6 shrink-0 mt-0.5"
								style={{ color: STATUS_COLORS.failed }}
							/>
							<div>
								<h3
									id={dialogTitleId}
									className="font-semibold text-base mb-2"
									style={{ color: theme.colors.textMain }}
								>
									Unable to Verify GitHub CLI
								</h3>
								<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
									Symphony could not verify the GitHub CLI status. Try the pre-flight check again
									before starting a contribution.
								</p>
							</div>
						</div>
						<div className="flex justify-end mt-4">
							<button
								onClick={onClose}
								className="px-4 py-2 rounded text-sm transition-colors hover:bg-white/10"
								style={{
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Close
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);

	return createPortal(dialog, document.body);
});
