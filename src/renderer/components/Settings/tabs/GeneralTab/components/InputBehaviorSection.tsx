import { AlertTriangle, Keyboard } from 'lucide-react';
import type { Theme } from '../../../../../types';
import {
	formatEnterToSend,
	formatMetaKey,
	formatShortcutKeys,
} from '../../../../../utils/shortcutFormatter';
import { ForcedParallelWarningModal } from '../../../../ForcedParallelWarningModal';
import type { ForcedParallelWarningState, GeneralTabSettings } from '../types';

interface InputBehaviorSectionProps {
	theme: Theme;
	enterToSendAI: boolean;
	setEnterToSendAI: (enabled: boolean) => void;
	enterToSendAIExpanded: boolean;
	setEnterToSendAIExpanded: (enabled: boolean) => void;
	forcedParallelExecution: boolean;
	forcedParallelAlways: boolean;
	setForcedParallelAlways: (enabled: boolean) => void;
	shortcuts: GeneralTabSettings['shortcuts'];
	forcedParallelWarning: ForcedParallelWarningState;
}

export function InputBehaviorSection({
	theme,
	enterToSendAI,
	setEnterToSendAI,
	enterToSendAIExpanded,
	setEnterToSendAIExpanded,
	forcedParallelExecution,
	forcedParallelAlways,
	setForcedParallelAlways,
	shortcuts,
	forcedParallelWarning,
}: InputBehaviorSectionProps) {
	const forcedParallelShortcut = shortcuts?.forcedParallelSend
		? formatShortcutKeys(shortcuts.forcedParallelSend.keys)
		: formatShortcutKeys(['Meta', 'Shift', 'Enter']);

	// "Always" mode makes every send a force-send, so the modifier shortcut is
	// redundant — we ghost it out to signal that.
	const alwaysMode = forcedParallelExecution && forcedParallelAlways;

	return (
		<div data-setting-id="general-input-behavior">
			<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<Keyboard className="w-3 h-3" />
				Input Send Behavior
			</div>
			<p className="text-xs opacity-50 mb-3">
				Configure how to send messages. Choose between Enter or {formatMetaKey()}
				+Enter.
			</p>

			<div
				className="mb-4 p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="flex items-center justify-between mb-2">
					<div className="text-sm font-medium">AI Interaction Mode</div>
					<button
						onClick={() => setEnterToSendAI(!enterToSendAI)}
						className="px-3 py-1.5 rounded text-xs font-mono transition-all"
						style={{
							backgroundColor: enterToSendAI ? theme.colors.accentDim : theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{formatEnterToSend(enterToSendAI)}
					</button>
				</div>
				<p className="text-xs opacity-50">
					{enterToSendAI
						? 'Press Enter to send. Use Shift+Enter for new line.'
						: `Press ${formatMetaKey()}+Enter to send. Enter creates new line.`}
				</p>
				<p className="text-[11px] opacity-40 mt-1">
					Default for new tabs. Toggling the chip in an AI tab (or running &quot;Toggle Enter to
					Send&quot; from the command palette) overrides this for that tab only.
				</p>
			</div>

			<div
				className="mb-4 p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="flex items-center justify-between mb-2">
					<div className="text-sm font-medium">Expanded AI Interaction Mode</div>
					<button
						onClick={() => setEnterToSendAIExpanded(!enterToSendAIExpanded)}
						className="px-3 py-1.5 rounded text-xs font-mono transition-all"
						style={{
							backgroundColor: enterToSendAIExpanded
								? theme.colors.accentDim
								: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{formatEnterToSend(enterToSendAIExpanded)}
					</button>
				</div>
				<p className="text-xs opacity-50">
					{enterToSendAIExpanded
						? 'In the expanded Prompt Composer, press Enter to send. Use Shift+Enter for new line.'
						: `In the expanded Prompt Composer, press ${formatMetaKey()}+Enter to send. Enter creates new line.`}
				</p>
			</div>

			<div
				className="mt-4 p-3 rounded border"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
					opacity: forcedParallelExecution ? 1 : 0.7,
				}}
			>
				<div className="flex items-center justify-between mb-2">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Forced Parallel Execution
					</div>
					<div className="flex items-center gap-2">
						<span
							className="px-2 py-0.5 rounded text-xs font-mono"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textMain,
								opacity: !forcedParallelExecution || alwaysMode ? 0.35 : 1,
								textDecoration: alwaysMode ? 'line-through' : 'none',
							}}
							title={alwaysMode ? 'Not needed in Always mode - every send is forced' : undefined}
						>
							{forcedParallelShortcut}
						</span>
						<button
							onClick={forcedParallelWarning.handleToggle}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
							style={{
								backgroundColor: forcedParallelExecution
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={forcedParallelExecution}
							aria-label="Forced Parallel Execution"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									forcedParallelExecution ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>
				</div>
				<div
					className="flex items-start gap-1.5 text-xs"
					style={{
						color: theme.colors.warning,
						opacity: forcedParallelExecution ? 1 : 0.5,
					}}
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
					<span>
						{alwaysMode ? (
							<>
								<strong>Every message force-sends</strong>, even while the agent is busy - no
								modifier needed. Parallel writes to the same files may cause one to overwrite the
								other.
							</>
						) : (
							<>
								When enabled, use <strong>{forcedParallelShortcut}</strong> to send messages even
								while the agent is busy. Parallel writes to the same files may cause one to
								overwrite the other.
							</>
						)}
					</span>
				</div>

				{forcedParallelExecution && (
					<div className="mt-3">
						<div className="text-[11px] font-bold opacity-60 uppercase mb-1.5">Send trigger</div>
						<div
							className="inline-flex rounded overflow-hidden"
							style={{ border: `1px solid ${theme.colors.border}` }}
							role="radiogroup"
							aria-label="Forced parallel send trigger"
						>
							<button
								onClick={() => setForcedParallelAlways(false)}
								className="px-3 py-1.5 text-xs font-medium transition-colors"
								style={{
									backgroundColor: !forcedParallelAlways
										? theme.colors.accent
										: theme.colors.bgActivity,
									color: !forcedParallelAlways ? theme.colors.bgMain : theme.colors.textMain,
								}}
								role="radio"
								aria-checked={!forcedParallelAlways}
							>
								Modifier
							</button>
							<button
								onClick={() => setForcedParallelAlways(true)}
								className="px-3 py-1.5 text-xs font-medium transition-colors"
								style={{
									backgroundColor: forcedParallelAlways
										? theme.colors.accent
										: theme.colors.bgActivity,
									color: forcedParallelAlways ? theme.colors.bgMain : theme.colors.textMain,
									borderLeft: `1px solid ${theme.colors.border}`,
								}}
								role="radio"
								aria-checked={forcedParallelAlways}
							>
								Always
							</button>
						</div>
						<p className="text-xs opacity-50 mt-1.5">
							{forcedParallelAlways
								? 'Every send force-sends past a busy agent. No modifier required.'
								: `Use ${forcedParallelShortcut} to force-send past a busy agent. A normal send queues as usual.`}
						</p>
					</div>
				)}
			</div>

			<ForcedParallelWarningModal
				isOpen={forcedParallelWarning.showWarning}
				onConfirm={forcedParallelWarning.handleConfirm}
				onCancel={forcedParallelWarning.handleCancel}
				theme={theme}
			/>
		</div>
	);
}
