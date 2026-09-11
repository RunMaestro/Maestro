/**
 * UpdatesChoiceModal - the first-run step for how Maestro stays current.
 *
 * Three switches and one install that already exist in Settings -> General,
 * where they sit among dozens of other controls and nobody finds them. The one
 * worth interrupting a first run for is the release candidate channel: a user
 * who wants new features early has to learn the channel exists before they can
 * opt into it. Crash reporting and the Maestro CLI ride along because both pay
 * off most when they are on from day one.
 *
 * Every switch writes straight to the setting it shows, and the modal reads the
 * live store rather than holding local copies. That is what makes the
 * returning-user case correct with no extra branch: someone who already turned
 * release candidates on, or crash reports off, sees their own answer here
 * rather than the shipped default pushed back at them.
 */

import { useRef } from 'react';
import { Bug, CheckCircle2, Download, FlaskConical, Terminal } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { ModalBackButton } from './ui/ModalBackButton';
import { ToggleSwitch } from './ui/ToggleSwitch';
import { useMaestroCliState } from './Settings/tabs/GeneralTab/hooks';

export interface UpdatesChoiceModalProps {
	theme: Theme;
	isOpen: boolean;
	checkForUpdatesOnStartup: boolean;
	onCheckForUpdatesOnStartupChange: (enabled: boolean) => void;
	enableBetaUpdates: boolean;
	onEnableBetaUpdatesChange: (enabled: boolean) => void;
	crashReportingEnabled: boolean;
	onCrashReportingEnabledChange: (enabled: boolean) => void;
	/** Mark the step seen and move on. */
	onDismiss: () => void;
	/**
	 * Reopen the previous step of the series. Omitted when there is none, in
	 * which case no Back control is drawn.
	 */
	onBack?: () => void;
}

function RecommendedBadge({ theme }: { theme: Theme }) {
	return (
		<span
			className="text-xs-plus font-bold px-2 py-0.5 rounded-full"
			style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
		>
			Recommended
		</span>
	);
}

function PreferenceRow({
	theme,
	icon: Icon,
	title,
	description,
	checked,
	onChange,
	recommended = false,
	testId,
}: {
	theme: Theme;
	icon: typeof Bug;
	title: string;
	description: string;
	checked: boolean;
	onChange: (enabled: boolean) => void;
	recommended?: boolean;
	testId: string;
}) {
	const toggle = () => onChange(!checked);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={toggle}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					toggle();
				}
			}}
			data-testid={testId}
			className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:bg-white/5"
			style={{
				// The release candidate row is the reason this step exists, so it is
				// the one drawn in the accent rather than blending into the list.
				borderColor: recommended ? theme.colors.accent : theme.colors.border,
				backgroundColor: recommended ? `${theme.colors.accent}10` : theme.colors.bgActivity,
			}}
		>
			<Icon className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
			<div className="flex-1 min-w-0">
				<div
					className="text-sm font-medium flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					{title}
					{recommended && <RecommendedBadge theme={theme} />}
				</div>
				<div className="text-xs leading-snug mt-0.5" style={{ color: theme.colors.textDim }}>
					{description}
				</div>
			</div>
			<ToggleSwitch checked={checked} onChange={onChange} theme={theme} ariaLabel={title} />
		</div>
	);
}

export function UpdatesChoiceModal({
	theme,
	isOpen,
	checkForUpdatesOnStartup,
	onCheckForUpdatesOnStartupChange,
	enableBetaUpdates,
	onEnableBetaUpdatesChange,
	crashReportingEnabled,
	onCrashReportingEnabledChange,
	onDismiss,
	onBack,
}: UpdatesChoiceModalProps) {
	const confirmRef = useRef<HTMLButtonElement>(null);

	// Hidden when the bridge exposes no CLI namespace, where an install button
	// could only fail.
	const cliAvailable = Boolean(window.maestro?.maestroCli);
	// The same state the Settings pane uses, so the two cannot disagree about
	// whether the CLI is installed or what an install reported.
	const cli = useMaestroCliState({ isOpen: isOpen && cliAvailable });
	const cliInstalled = cli.status?.needsInstallOrUpdate === false;
	const cliBusy = cli.checking || cli.installing;

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Stay on the Bleeding Edge"
			headerIcon={<FlaskConical className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.UPDATES_CHOICE}
			onClose={onDismiss}
			closeOnBackdropClick={false}
			width={640}
			maxWidthCss="92vw"
			initialFocusRef={confirmRef}
			testId="updates-choice-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					{onBack && <ModalBackButton theme={theme} onBack={onBack} testId="updates-choice-back" />}
					<button
						ref={confirmRef}
						type="button"
						onClick={onDismiss}
						data-testid="updates-choice-confirm"
						className="ml-auto px-3 py-1.5 rounded text-xs font-bold"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Continue
					</button>
				</div>
			}
		>
			<div className="space-y-4 select-none">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					If you want the most bleeding-edge features, we highly recommend opting into release
					candidates. And please leave crash reporting enabled: it helps us rapidly fix problems,
					automatically, as they are discovered.
				</p>

				<div className="space-y-2">
					<PreferenceRow
						theme={theme}
						icon={Download}
						title="Check for updates automatically"
						description="Check for new Maestro versions on startup and once per day while the app is running."
						checked={checkForUpdatesOnStartup}
						onChange={onCheckForUpdatesOnStartupChange}
						testId="updates-choice-auto-check"
					/>
					<PreferenceRow
						theme={theme}
						icon={FlaskConical}
						title="Include beta and release candidate updates"
						description="Get new features as soon as they ship, ahead of the stable release. Pre-releases can contain bugs."
						checked={enableBetaUpdates}
						onChange={onEnableBetaUpdatesChange}
						recommended
						testId="updates-choice-beta"
					/>
					<PreferenceRow
						theme={theme}
						icon={Bug}
						title="Send anonymous crash reports"
						description="Lets us find and fix problems as they happen. No personal data is collected. Takes effect after restart."
						checked={crashReportingEnabled}
						onChange={onCrashReportingEnabledChange}
						testId="updates-choice-crash-reports"
					/>
				</div>

				{cliAvailable && (
					<div
						data-testid="updates-choice-cli"
						className="p-3 rounded-lg border space-y-2"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
					>
						<div className="flex items-center gap-3">
							<Terminal className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
							<div className="flex-1 min-w-0">
								<div
									className="text-sm font-medium flex items-center gap-2"
									style={{ color: theme.colors.textMain }}
								>
									Maestro CLI
									{!cliInstalled && <RecommendedBadge theme={theme} />}
								</div>
								<div
									className="text-xs leading-snug mt-0.5"
									style={{ color: theme.colors.textDim }}
								>
									The Maestro CLI can be used by humans, but it is really intended for your agents,
									so they can automate everything Maestro can do. We highly recommend installing it.
								</div>
							</div>
							{cliInstalled ? (
								<span
									data-testid="updates-choice-cli-installed"
									className="flex items-center gap-1 text-xs font-bold shrink-0"
									style={{ color: theme.colors.success }}
								>
									<CheckCircle2 className="w-4 h-4" />
									Installed
								</span>
							) : (
								<button
									type="button"
									onClick={() => void cli.installOrUpdate()}
									disabled={cliBusy}
									data-testid="updates-choice-install-cli"
									className="px-3 py-1.5 rounded text-xs font-bold shrink-0"
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.accentForeground,
										opacity: cliBusy ? 0.6 : 1,
									}}
								>
									{cli.installing
										? 'Installing...'
										: cli.checking
											? 'Checking...'
											: cli.status?.installed
												? 'Update Maestro CLI'
												: 'Install Maestro CLI'}
								</button>
							)}
						</div>
						{(cli.statusError || cli.installMessage) && (
							<div
								role={cli.statusError ? 'alert' : 'status'}
								aria-live={cli.statusError ? 'assertive' : 'polite'}
								className="text-xs space-y-1 select-text"
							>
								{cli.statusError && (
									<div style={{ color: theme.colors.warning }}>{cli.statusError}</div>
								)}
								{cli.installMessage && (
									<div style={{ color: theme.colors.success }}>{cli.installMessage}</div>
								)}
							</div>
						)}
					</div>
				)}

				<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
					These are your current settings. You can change any of them later in Settings &rarr;
					General.
				</p>
			</div>
		</Modal>
	);
}

export default UpdatesChoiceModal;
