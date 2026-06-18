import { Compass, Rocket } from 'lucide-react';
import type { RefObject } from 'react';
import { Spinner } from '../../../../ui/Spinner';
import { RadioGroup, type RadioOption } from '../../../../ui/RadioGroup';
import type { Theme } from '../../../../../types';
import type { GeneratedDocument, WizardAutoRunMode } from '../../../WizardContext';
import type { LaunchingButton } from '../types';
import { formatShortcutKeys } from '../../../../../utils/shortcutFormatter';

export function PhaseReviewFooter({
	theme,
	generatedDocuments,
	autoRunMode,
	setAutoRunMode,
	launchingButton,
	readyButtonRef,
	tourButtonRef,
	onLaunch,
}: {
	theme: Theme;
	generatedDocuments: GeneratedDocument[];
	autoRunMode: WizardAutoRunMode;
	setAutoRunMode: (mode: WizardAutoRunMode) => void;
	launchingButton: LaunchingButton;
	readyButtonRef: RefObject<HTMLButtonElement>;
	tourButtonRef: RefObject<HTMLButtonElement>;
	onLaunch: (wantsTour: boolean) => void;
}): JSX.Element {
	return (
		<div
			className="px-6 py-4 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<div className="mb-3">
				<RadioGroup<WizardAutoRunMode>
					value={autoRunMode}
					onChange={setAutoRunMode}
					theme={theme}
					ariaLabel="Auto Run launch mode"
					options={
						[
							{
								value: 'all',
								label: 'Execute all Auto Run phases',
								description:
									generatedDocuments.length > 1
										? 'Run every generated phase sequentially after launch'
										: 'Run the generated phase after launch',
							},
							{
								value: 'first',
								label: 'Start first Auto Run phase',
								description: 'Only run the first phase; you can launch the rest manually',
								disabled: generatedDocuments.length < 2,
							},
							{
								value: 'none',
								label: "Don't start Auto Run",
								description: 'Drop straight into the agent without kicking off Auto Run',
							},
						] as ReadonlyArray<RadioOption<WizardAutoRunMode>>
					}
				/>
			</div>

			<div className="flex flex-col sm:flex-row gap-3">
				<button
					ref={readyButtonRef}
					onClick={() => onLaunch(false)}
					disabled={launchingButton !== null}
					className={`flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg font-semibold text-base transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 ${
						launchingButton !== null ? 'opacity-70 cursor-not-allowed' : 'hover:scale-[1.02]'
					}`}
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
						boxShadow: `0 4px 14px ${theme.colors.accent}40`,
						['--tw-ring-color' as any]: theme.colors.textMain,
						['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
					}}
				>
					{launchingButton === 'ready' ? <Spinner size={20} /> : <Rocket className="w-5 h-5" />}
					{launchingButton === 'ready' ? 'Launching...' : "I'm Ready to Go"}
				</button>

				<button
					ref={tourButtonRef}
					onClick={() => onLaunch(true)}
					disabled={launchingButton !== null}
					className={`flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg font-medium text-base transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 ${
						launchingButton !== null ? 'opacity-70 cursor-not-allowed' : 'hover:scale-[1.02]'
					}`}
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `2px solid ${theme.colors.border}`,
						['--tw-ring-color' as any]: theme.colors.accent,
						['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
					}}
				>
					{launchingButton === 'tour' ? <Spinner size={20} /> : <Compass className="w-5 h-5" />}
					{launchingButton === 'tour' ? 'Launching...' : 'Walk Me Through the Interface'}
				</button>
			</div>

			<div className="mt-4 flex justify-center gap-6 flex-wrap">
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						{formatShortcutKeys(['Meta', 'e'])}
					</kbd>
					Toggle Edit/Preview
				</span>
				{generatedDocuments.length > 1 && (
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							{formatShortcutKeys(['Meta', 'Shift'])}[]
						</kbd>
						Cycle documents
					</span>
				)}
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						Tab
					</kbd>
					Switch buttons
				</span>
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						Enter
					</kbd>
					Select
				</span>
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						Esc
					</kbd>
					Go back
				</span>
			</div>
		</div>
	);
}
