/**
 * DirectorySelectionScreen.tsx
 *
 * Second screen of the onboarding wizard - allows users to select
 * a project directory with browse functionality and Git repo detection.
 *
 * Features:
 * - Directory path input field
 * - Browse button (native folder picker via window.maestro.dialog.selectFolder())
 * - Auto-detection of agent path using window.maestro.agents.get()
 * - Git repo indicator showing whether selected path is a Git repository
 * - Keyboard support (Tab between fields, Enter to proceed, Escape to go back)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Theme, AgentConfig } from '../../../types';
import type { SshRemoteConfig } from '../../../../shared/types';
import { useWizard } from '../WizardContext';
import { ScreenReaderAnnouncement } from '../ScreenReaderAnnouncement';
import { ExistingDocsModal } from '../ExistingDocsModal';
import { AUTO_RUN_FOLDER_NAME } from '../services/phaseGenerator';

interface DirectorySelectionScreenProps {
	theme: Theme;
}

/**
 * DirectorySelectionScreen - Project directory selection with Git detection
 */
export function DirectorySelectionScreen({ theme }: DirectorySelectionScreenProps): JSX.Element {
	const {
		state,
		setDirectoryPath,
		setIsGitRepo,
		setDirectoryError,
		setHasExistingAutoRunDocs,
		setExistingDocsChoice,
		nextStep,
		previousStep,
		canProceedToNext,
	} = useWizard();

	// Local state
	const [isValidating, setIsValidating] = useState(false);
	const [isBrowsing, setIsBrowsing] = useState(false);
	const [isDetecting, setIsDetecting] = useState(true);
	const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
	const [showExistingDocsModal, setShowExistingDocsModal] = useState(false);
	const [sshRemoteHost, setSshRemoteHost] = useState<string | null>(null);

	// Screen reader announcement state
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	/**
	 * Extract the YOLO/permission-skip flag from agent config.
	 * Includes the binary name prefix (e.g., "codex run" or "claude --dangerously...")
	 */
	const getYoloFlag = useCallback((): string | null => {
		if (!agentConfig) return null;

		const binaryName = agentConfig.binaryName || agentConfig.command || 'agent';

		// First check yoloModeArgs (the dedicated property for YOLO mode)
		if (agentConfig.yoloModeArgs && agentConfig.yoloModeArgs.length > 0) {
			// Return binary name + YOLO mode args
			return `${binaryName} ${agentConfig.yoloModeArgs.join(' ')}`;
		}

		// Fall back to searching in base args
		if (!agentConfig.args) return null;
		const yoloPatterns = [
			/--dangerously-skip-permissions/,
			/--dangerously-bypass-approvals/,
			/--yolo/,
			/--no-confirm/,
			/--yes/,
			/-y\b/,
		];
		for (const arg of agentConfig.args) {
			for (const pattern of yoloPatterns) {
				if (pattern.test(arg)) {
					return `${binaryName} ${arg}`;
				}
			}
		}
		return null;
	}, [agentConfig]);

	// Refs for focus management
	const inputRef = useRef<HTMLInputElement>(null);
	const browseButtonRef = useRef<HTMLButtonElement>(null);
	const continueButtonRef = useRef<HTMLButtonElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	/**
	 * Fetch agent config when selected agent changes
	 */
	useEffect(() => {
		let mounted = true;

		async function fetchAgentConfig() {
			if (!state.selectedAgent) return;
			try {
				const config = await window.maestro.agents.get(state.selectedAgent);
				if (mounted && config) {
					setAgentConfig(config);
				}
			} catch (error) {
				console.error('Failed to fetch agent config:', error);
			}
		}

		fetchAgentConfig();
		return () => {
			mounted = false;
		};
	}, [state.selectedAgent]);

	/**
	 * Mark detection as complete on mount
	 */
	useEffect(() => {
		// No pre-fill - user should browse to select their project folder
		setIsDetecting(false);
	}, []);

	/**
	 * Load SSH remote host name when remote is configured
	 */
	useEffect(() => {
		if (!state.sessionSshRemoteConfig?.enabled || !state.sessionSshRemoteConfig?.remoteId) {
			setSshRemoteHost(null);
			return;
		}

		async function loadSshRemoteHost() {
			try {
				const configsResult = await window.maestro.sshRemote.getConfigs();
				if (configsResult.success && configsResult.configs) {
					const remote = configsResult.configs.find(
						(r: SshRemoteConfig) => r.id === state.sessionSshRemoteConfig?.remoteId
					);
					if (remote) {
						setSshRemoteHost(remote.name || remote.host);
					}
				}
			} catch (error) {
				console.error('Failed to load SSH remote config:', error);
			}
		}

		loadSshRemoteHost();
	}, [state.sessionSshRemoteConfig?.enabled, state.sessionSshRemoteConfig?.remoteId]);

	/**
	 * Get the SSH remote ID from wizard state (if configured)
	 */
	const getSshRemoteId = useCallback((): string | undefined => {
		if (state.sessionSshRemoteConfig?.enabled && state.sessionSshRemoteConfig?.remoteId) {
			return state.sessionSshRemoteConfig.remoteId;
		}
		return undefined;
	}, [state.sessionSshRemoteConfig]);

	/**
	 * Check if Auto Run Docs folder exists in the given path
	 */
	const checkForExistingDocs = useCallback(
		async (dirPath: string): Promise<{ exists: boolean; count: number }> => {
			try {
				const autoRunPath = `${dirPath}/${AUTO_RUN_FOLDER_NAME}`;
				const sshRemoteId = getSshRemoteId();
				const result = await window.maestro.autorun.listDocs(autoRunPath, sshRemoteId);
				if (result.success && result.files && result.files.length > 0) {
					return { exists: true, count: result.files.length };
				}
				return { exists: false, count: 0 };
			} catch {
				// Folder doesn't exist or error reading it
				return { exists: false, count: 0 };
			}
		},
		[getSshRemoteId]
	);

	/**
	 * Validate directory and check Git repo status
	 */
	const validateDirectory = useCallback(
		async (
			path: string,
			shouldAnnounce: boolean = true,
			skipExistingDocsCheck: boolean = false
		) => {
			if (!path.trim()) {
				setDirectoryError(null);
				setIsGitRepo(false);
				setHasExistingAutoRunDocs(false, 0);
				return;
			}

			setIsValidating(true);
			setDirectoryError(null);

			try {
				// First, verify the directory exists by attempting to read it
				// This will throw if the directory doesn't exist or is inaccessible
				const sshRemoteId = getSshRemoteId();
				try {
					await window.maestro.fs.readDir(path, sshRemoteId);
				} catch (dirError) {
					// Directory doesn't exist or can't be accessed
					console.error('Directory does not exist:', dirError);
					setDirectoryError('Directory not found. Please check the path exists.');
					setIsGitRepo(false);
					setHasExistingAutoRunDocs(false, 0);

					// Announce error
					if (shouldAnnounce) {
						setAnnouncement('Error: Directory not found. Please check the path exists.');
						setAnnouncementKey((prev) => prev + 1);
					}
					setIsValidating(false);
					return;
				}

				// Directory exists, now check if it's a git repo
				const isRepo = await window.maestro.git.isRepo(path, sshRemoteId);
				setIsGitRepo(isRepo);
				setDirectoryError(null);

				// Check for existing Auto Run Docs folder (unless we're skipping because user already made a choice)
				if (!skipExistingDocsCheck && !state.existingDocsChoice) {
					const existingDocs = await checkForExistingDocs(path);
					setHasExistingAutoRunDocs(existingDocs.exists, existingDocs.count);
				}

				// Announce validation result
				if (shouldAnnounce) {
					if (isRepo) {
						setAnnouncement('Directory validated. Git repository detected.');
					} else {
						setAnnouncement('Directory validated. Not a Git repository.');
					}
					setAnnouncementKey((prev) => prev + 1);
				}
			} catch (error) {
				// If git check fails, the directory might not exist or is inaccessible
				console.error('Directory validation error:', error);
				setDirectoryError('Unable to access this directory. Please check the path exists.');
				setIsGitRepo(false);
				setHasExistingAutoRunDocs(false, 0);

				// Announce error
				if (shouldAnnounce) {
					setAnnouncement('Error: Unable to access this directory. Please check the path exists.');
					setAnnouncementKey((prev) => prev + 1);
				}
			}

			setIsValidating(false);
		},
		[
			setIsGitRepo,
			setDirectoryError,
			setHasExistingAutoRunDocs,
			checkForExistingDocs,
			state.existingDocsChoice,
			getSshRemoteId,
		]
	);

	/**
	 * Focus input on mount (after detection completes)
	 */
	useEffect(() => {
		if (!isDetecting && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isDetecting]);

	/**
	 * Handle path input change with debounced validation
	 */
	const handlePathChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const newPath = e.target.value;
			setDirectoryPath(newPath);

			// Debounce validation to avoid excessive API calls while typing
			if (newPath.trim()) {
				const timeoutId = setTimeout(() => {
					validateDirectory(newPath);
				}, 500);
				return () => clearTimeout(timeoutId);
			} else {
				setDirectoryError(null);
				setIsGitRepo(false);
			}
		},
		[setDirectoryPath, setDirectoryError, setIsGitRepo, validateDirectory]
	);

	/**
	 * Handle browse button click - open native folder picker
	 */
	const handleBrowse = useCallback(async () => {
		setIsBrowsing(true);

		try {
			const selectedPath = await window.maestro.dialog.selectFolder();
			if (selectedPath) {
				setDirectoryPath(selectedPath);
				await validateDirectory(selectedPath);
				// Focus the continue button after selection - use longer timeout to ensure
				// React has re-rendered with updated state and the button is visible
				setTimeout(() => {
					continueButtonRef.current?.focus();
				}, 150);
			}
		} catch (error) {
			console.error('Browse failed:', error);
			setDirectoryError('Failed to open folder picker');
		}

		setIsBrowsing(false);
	}, [setDirectoryPath, validateDirectory, setDirectoryError]);

	/**
	 * Attempt to proceed to next step
	 * Shows modal if Auto Run Docs folder exists and is not empty
	 */
	const attemptNextStep = useCallback(async () => {
		if (!canProceedToNext()) return;

		// If user already made a choice about existing docs, proceed
		if (state.existingDocsChoice) {
			nextStep();
			return;
		}

		// Check if Auto Run Docs folder exists and has files
		try {
			const autoRunPath = `${state.directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
			const sshRemoteId = getSshRemoteId();
			const result = await window.maestro.autorun.listDocs(autoRunPath, sshRemoteId);
			const docs = result.success ? result.files : [];

			if (docs && docs.length > 0) {
				// Update the count and show the modal
				setHasExistingAutoRunDocs(true, docs.length);
				setShowExistingDocsModal(true);
				return;
			}
		} catch {
			// Folder doesn't exist or can't be read - that's fine, proceed
		}

		nextStep();
	}, [
		canProceedToNext,
		nextStep,
		state.directoryPath,
		state.existingDocsChoice,
		setHasExistingAutoRunDocs,
		getSshRemoteId,
	]);

	/**
	 * Handle "Start Fresh" choice - docs already deleted by modal
	 */
	const handleStartFresh = useCallback(() => {
		setShowExistingDocsModal(false);
		setExistingDocsChoice('fresh');
		setHasExistingAutoRunDocs(false, 0);
		nextStep();
	}, [setExistingDocsChoice, setHasExistingAutoRunDocs, nextStep]);

	/**
	 * Handle "Continue" choice - keep existing docs and analyze them
	 */
	const handleContinueWithDocs = useCallback(() => {
		setShowExistingDocsModal(false);
		setExistingDocsChoice('continue');
		nextStep();
	}, [setExistingDocsChoice, nextStep]);

	/**
	 * Handle modal cancel - user wants to choose a different directory
	 */
	const handleModalCancel = useCallback(() => {
		setShowExistingDocsModal(false);
		// Clear directory to prompt user to pick a new one
		setDirectoryPath('');
		setHasExistingAutoRunDocs(false, 0);
		inputRef.current?.focus();
	}, [setDirectoryPath, setHasExistingAutoRunDocs]);

	/**
	 * Handle keyboard navigation
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			switch (e.key) {
				case 'Enter':
					// If Browse button is focused, click it instead of trying to proceed
					if (document.activeElement === browseButtonRef.current) {
						e.preventDefault();
						if (!isBrowsing) {
							handleBrowse();
						}
						return;
					}
					e.preventDefault();
					if (canProceedToNext() && !isValidating) {
						attemptNextStep();
					}
					break;

				case 'Escape':
					e.preventDefault();
					previousStep();
					break;
			}
		},
		[canProceedToNext, isValidating, attemptNextStep, previousStep, isBrowsing, handleBrowse]
	);

	/**
	 * Handle continue button click
	 */
	const handleContinue = useCallback(() => {
		if (canProceedToNext()) {
			attemptNextStep();
		}
	}, [canProceedToNext, attemptNextStep]);

	/**
	 * Handle back button click
	 */
	const _handleBack = useCallback(() => {
		previousStep();
	}, [previousStep]);

	// Loading state while detecting agent path
	if (isDetecting) {
		return (
			<div
				className="flex-1 flex flex-col items-center justify-center p-8"
				style={{ color: theme.colors.textMain }}
			>
				<div
					className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mb-4"
					style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
				/>
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					Detecting project location...
				</p>
			</div>
		);
	}

	const isValid = canProceedToNext();
	const showContinue = state.directoryPath.trim() !== '';
	const isRemoteSession = !!state.sessionSshRemoteConfig?.enabled;

	return (
		<div
			ref={containerRef}
			className="flex flex-col flex-1 min-h-0 p-8 overflow-y-auto outline-none"
			onKeyDown={handleKeyDown}
			tabIndex={-1}
		>
			{/* Screen reader announcements */}
			<ScreenReaderAnnouncement
				message={announcement}
				announceKey={announcementKey}
				politeness="polite"
			/>

			{/* Header */}
			<div className="text-center">
				{/* Agent greeting - prominent at top */}
				<h2 className="text-3xl font-bold mb-6" style={{ color: theme.colors.accent }}>
					Howdy, I'm {state.agentName || 'your agent'}
				</h2>
				<h3 className="text-xl font-semibold mb-4" style={{ color: theme.colors.textMain }}>
					Where Should We Work?
				</h3>
				<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
					Choose the folder where your project lives (or will live).
				</p>
				<p
					className="text-xs max-w-lg mx-auto"
					style={{ color: theme.colors.textDim, opacity: 0.8 }}
				>
					Do note, as a matter of design I operate in{' '}
					<code
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.warning, color: theme.colors.bgMain }}
					>
						YOLO
					</code>{' '}
					mode, aka:
				</p>
				{getYoloFlag() && (
					<div className="my-3 flex justify-center">
						<code
							className="px-2 py-1 rounded text-xs"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.warning }}
						>
							{getYoloFlag()}
						</code>
					</div>
				)}
				<p
					className="text-xs max-w-lg mx-auto"
					style={{ color: theme.colors.textDim, opacity: 0.8 }}
				>
					I do my best to only make changes within this directory...
					<br />
					That said, Caveat Emptor.
				</p>
			</div>

			{/* Spacer before Project Directory */}
			<div className="flex-1" />

			{/* Main content area - centered */}
			<div className="flex flex-col items-center">
				<div className="w-full max-w-xl">
					{/* Directory path input with browse button */}
					<div className="mb-8">
						<label
							htmlFor="directory-path"
							className="block text-sm mb-2 font-medium"
							style={{ color: theme.colors.textMain }}
						>
							Project Directory
						</label>
						<div className="flex gap-3">
							<input
								ref={inputRef}
								id="directory-path"
								type="text"
								value={state.directoryPath}
								onChange={handlePathChange}
								placeholder={
									isRemoteSession
										? `Enter path on ${sshRemoteHost || 'remote host'} (e.g., /home/user/project)`
										: '/path/to/your/project'
								}
								className="flex-1 px-4 py-3 rounded-lg border text-base outline-none transition-all font-mono"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: state.directoryError
										? theme.colors.error
										: document.activeElement === inputRef.current
											? theme.colors.accent
											: theme.colors.border,
									color: theme.colors.textMain,
									boxShadow:
										document.activeElement === inputRef.current
											? `0 0 0 2px ${theme.colors.accent}40`
											: 'none',
								}}
								aria-invalid={!!state.directoryError}
								aria-describedby={state.directoryError ? 'directory-error' : undefined}
							/>
							{/* Browse button - hidden for remote sessions */}
							{!isRemoteSession && (
								<button
									ref={browseButtonRef}
									onClick={handleBrowse}
									disabled={isBrowsing}
									className="px-6 py-3 rounded-lg font-medium transition-all flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2"
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.accentForeground,
										opacity: isBrowsing ? 0.7 : 1,
										['--tw-ring-color' as any]: theme.colors.accent,
										['--tw-ring-offset-color' as any]: theme.colors.bgMain,
									}}
								>
									{isBrowsing ? (
										<>
											<div
												className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
												style={{
													borderColor: theme.colors.accentForeground,
													borderTopColor: 'transparent',
												}}
											/>
											<span>Opening...</span>
										</>
									) : (
										<>
											<svg
												className="w-5 h-5"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
												/>
											</svg>
											<span>Browse</span>
										</>
									)}
								</button>
							)}
						</div>

						{/* Remote session hint */}
						{isRemoteSession && (
							<p
								className="mt-2 text-xs flex items-center gap-1.5"
								style={{ color: theme.colors.textDim }}
							>
								<svg
									className="w-4 h-4 flex-shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
									/>
								</svg>
								Enter the full path on <strong>{sshRemoteHost || 'the remote host'}</strong> — path
								will be validated as you type
							</p>
						)}

						{/* Error message */}
						{state.directoryError && (
							<p
								id="directory-error"
								className="mt-2 text-sm flex items-center gap-2"
								style={{ color: theme.colors.error }}
							>
								<svg
									className="w-4 h-4 flex-shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
									/>
								</svg>
								{state.directoryError}
							</p>
						)}
					</div>

					{/* Git repo status indicator */}
					{state.directoryPath.trim() && !state.directoryError && !isValidating && (
						<div
							className="mb-6 p-4 rounded-lg border flex items-center gap-3"
							style={{
								backgroundColor: state.isGitRepo
									? `${theme.colors.success}10`
									: theme.colors.bgSidebar,
								borderColor: state.isGitRepo ? theme.colors.success : theme.colors.border,
							}}
						>
							{state.isGitRepo ? (
								<>
									<div
										className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
										style={{ backgroundColor: theme.colors.success }}
									>
										<svg className="w-5 h-5" fill="none" stroke="white" viewBox="0 0 24 24">
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M5 13l4 4L19 7"
											/>
										</svg>
									</div>
									<div>
										<p className="font-medium" style={{ color: theme.colors.textMain }}>
											Git Repository Detected
										</p>
										<p className="text-xs" style={{ color: theme.colors.textDim }}>
											Version control features like branch tracking, change detection, and worktrees
											will be available.
										</p>
									</div>
								</>
							) : (
								<>
									<div
										className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
										style={{ backgroundColor: theme.colors.border }}
									>
										<svg
											className="w-5 h-5"
											fill="none"
											stroke={theme.colors.textDim}
											viewBox="0 0 24 24"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
											/>
										</svg>
									</div>
									<div>
										<p className="font-medium" style={{ color: theme.colors.textMain }}>
											Regular Directory
										</p>
										<p className="text-xs" style={{ color: theme.colors.textDim }}>
											Not a Git repository. You can initialize one later if needed.
										</p>
									</div>
								</>
							)}
						</div>
					)}

					{/* Git explanation - shown after directory status */}
					{state.directoryPath.trim() && !state.directoryError && !isValidating && (
						<p className="text-xs text-center mb-6" style={{ color: theme.colors.textDim }}>
							Git repositories get extra features like branch tracking, change detection, and
							worktrees. Regular folders work too!
						</p>
					)}

					{/* Validating indicator */}
					{isValidating && (
						<div
							className="mb-6 p-4 rounded-lg border flex items-center gap-3"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
							}}
						>
							<div
								className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
								style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
							/>
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Validating directory...
							</p>
						</div>
					)}
				</div>
			</div>

			{/* Spacer after content / before Continue button */}
			<div className="flex-1" />

			{/* Continue button - centered */}
			{showContinue && (
				<div className="flex justify-center">
					<button
						ref={continueButtonRef}
						onClick={handleContinue}
						disabled={!isValid || isValidating}
						className="px-12 py-3 rounded-lg font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2"
						style={{
							backgroundColor: isValid && !isValidating ? theme.colors.accent : theme.colors.border,
							color:
								isValid && !isValidating ? theme.colors.accentForeground : theme.colors.textDim,
							cursor: isValid && !isValidating ? 'pointer' : 'not-allowed',
							opacity: isValid && !isValidating ? 1 : 0.6,
							minWidth: '200px',
							['--tw-ring-color' as any]: theme.colors.accent,
							['--tw-ring-offset-color' as any]: theme.colors.bgMain,
						}}
					>
						Continue
					</button>
				</div>
			)}

			{/* Spacer after Continue button / before keyboard hints */}
			<div className="flex-1" />

			{/* Keyboard hints */}
			<div className="flex justify-center gap-6">
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						Tab
					</kbd>
					Navigate
				</span>
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						Enter
					</kbd>
					Continue
				</span>
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						Esc
					</kbd>
					Exit Wizard
				</span>
			</div>

			{/* Existing docs modal */}
			{showExistingDocsModal && (
				<ExistingDocsModal
					theme={theme}
					documentCount={state.existingDocsCount}
					directoryPath={state.directoryPath}
					onStartFresh={handleStartFresh}
					onContinue={handleContinueWithDocs}
					onCancel={handleModalCancel}
				/>
			)}
		</div>
	);
}
