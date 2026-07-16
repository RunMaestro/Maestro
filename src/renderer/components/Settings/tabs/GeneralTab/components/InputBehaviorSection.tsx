import { AlertTriangle, Keyboard } from 'lucide-react';
import type { Theme } from '../../../../../types';
import {
	formatEnterToSend,
	formatMetaKey,
	formatShortcutKeys,
} from '../../../../../utils/shortcutFormatter';
import { ForcedParallelWarningModal } from '../../../../ForcedParallelWarningModal';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import type { ForcedParallelWarningState, GeneralTabSettings } from '../types';

interface InputBehaviorSectionProps {
	theme: Theme;
	enterToSendAI: boolean;
	setEnterToSendAI: (enabled: boolean) => void;
	enterToSendAIExpanded: boolean;
	setEnterToSendAIExpanded: (enabled: boolean) => void;
	forcedParallelExecution: boolean;
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
	shortcuts,
	forcedParallelWarning,
}: InputBehaviorSectionProps) {
	const forcedParallelShortcut = shortcuts?.forcedParallelSend
		? formatShortcutKeys(shortcuts.forcedParallelSend.keys)
		: formatShortcutKeys(['Meta', 'Shift', 'Enter']);

	return (
		<div data-setting-id="general-input-behavior">
			<SettingsSectionHeading icon={Keyboard}>Input Send Behavior</SettingsSectionHeading>
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
								opacity: forcedParallelExecution ? 1 : 0.5,
							}}
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
						When enabled, use <strong>{forcedParallelShortcut}</strong> to send messages even while
						the agent is busy. Parallel writes to the same files may cause one to overwrite the
						other.
					</span>
				</div>
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
