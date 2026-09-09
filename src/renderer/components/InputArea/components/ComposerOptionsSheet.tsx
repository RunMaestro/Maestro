/**
 * ComposerOptionsSheet - everything the composer toolbar offers, on a phone.
 *
 * The desktop toolbar spreads History / Access / Thinking / Model / Effort
 * across one row of pills, each opening its own dropdown. At 390px that row
 * cannot hold them: it wrapped, then the model and effort pills crowded the
 * send button, and their dropdowns opened as anchored popovers sized for a
 * mouse. So on a phone the toolbar keeps only what a thumb reaches for while
 * typing (attach an image, send) plus a "..." that opens this sheet.
 *
 * Everything here is an ACCORDION rather than a tap-to-cycle pill. Access and
 * Thinking are three-state on the desktop toolbar and advance one step per
 * click, which is a fine control beside a mouse and a poor one on a
 * touchscreen: the user cannot see the options, cannot go back, and has to tap
 * twice through a state they did not want. Listing the options and letting one
 * be picked is the same information in a form a finger can use. History is a
 * plain boolean, so it stays a switch.
 */

import { memo, useState } from 'react';
import { Brain, Check, ChevronDown, Eye, Gauge, History, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Theme, ThinkingMode } from '../../../types';
import { getPermissionModeLabel } from '../../../../shared/agentMetadata';
import { THINKING_MODES } from '../../../../shared/types';
import { PhoneBottomSheet } from '../../ui/PhoneBottomSheet';

export type PermissionMode = 'full' | 'standard' | 'readonly';

interface ComposerOptionsSheetProps {
	open: boolean;
	onClose: () => void;
	theme: Theme;
	/** Provider id, so read-only reads as the agent's own word for it. */
	agentId?: string;
	tabSaveToHistory: boolean;
	onToggleTabSaveToHistory?: () => void;
	hasReadOnlyCapability: boolean;
	/** Whether `standard` is functional for this agent (has a working relay). */
	hasStandardCapability: boolean;
	permissionMode: PermissionMode;
	onPermissionModeChange: (mode: PermissionMode) => void;
	supportsThinking: boolean;
	tabShowThinking: ThinkingMode;
	onThinkingModeChange?: (mode: ThinkingMode) => void;
	currentModel?: string;
	availableModels: string[];
	onModelChange?: (model: string) => void;
	currentEffort?: string;
	availableEfforts: string[];
	onEffortChange?: (effort: string) => void;
}

const THINKING_LABELS: Record<ThinkingMode, string> = {
	off: 'Off',
	on: 'On',
	sticky: 'Sticky',
};

/**
 * One expandable row: a header the user taps, and the option list beneath it.
 *
 * Only one section is open at a time (the sheet owns that state), because the
 * panel is half a screen and two open lists would push the second below the
 * fold with no sign it is there.
 */
function OptionSection({
	icon: Icon,
	label,
	value,
	accent,
	expanded,
	onToggle,
	children,
	theme,
	testId,
}: {
	icon: LucideIcon;
	label: string;
	value: string;
	accent: string;
	expanded: boolean;
	onToggle: () => void;
	children: React.ReactNode;
	theme: Theme;
	testId: string;
}) {
	return (
		<div className="border-b" style={{ borderColor: theme.colors.border }}>
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-3 px-4 text-left"
				style={{ minHeight: 52, color: theme.colors.textMain }}
				aria-expanded={expanded}
				data-testid={testId}
			>
				<Icon className="w-4 h-4 shrink-0" style={{ color: accent }} />
				<span className="text-sm flex-1 min-w-0">{label}</span>
				<span className="text-xs font-mono truncate max-w-[45%]" style={{ color: accent }}>
					{value}
				</span>
				<ChevronDown
					className={`w-4 h-4 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
					style={{ color: theme.colors.textDim }}
					aria-hidden="true"
				/>
			</button>
			{expanded && <div className="pb-2">{children}</div>}
		</div>
	);
}

/** One selectable option inside an expanded section. */
function OptionRow({
	label,
	selected,
	accent,
	onSelect,
	theme,
}: {
	label: string;
	selected: boolean;
	accent: string;
	onSelect: () => void;
	theme: Theme;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex w-full items-center gap-3 pl-11 pr-4 text-left"
			style={{
				minHeight: 44,
				color: selected ? accent : theme.colors.textMain,
				backgroundColor: selected ? `${accent}12` : undefined,
			}}
			aria-pressed={selected}
		>
			<span className="text-sm flex-1 min-w-0 truncate">{label}</span>
			{selected && <Check className="w-4 h-4 shrink-0" aria-hidden="true" />}
		</button>
	);
}

export const ComposerOptionsSheet = memo(function ComposerOptionsSheet({
	open,
	onClose,
	theme,
	agentId,
	tabSaveToHistory,
	onToggleTabSaveToHistory,
	hasReadOnlyCapability,
	hasStandardCapability,
	permissionMode,
	onPermissionModeChange,
	supportsThinking,
	tabShowThinking,
	onThinkingModeChange,
	currentModel,
	availableModels,
	onModelChange,
	currentEffort,
	availableEfforts,
	onEffortChange,
}: ComposerOptionsSheetProps) {
	const [expanded, setExpanded] = useState<string | null>(null);
	const toggle = (key: string) => setExpanded((prev) => (prev === key ? null : key));

	// `standard` is hidden for an agent with no working relay: offering it would
	// let the user pick a mode whose tool approvals never arrive.
	const permissionModes: PermissionMode[] = hasStandardCapability
		? ['full', 'standard', 'readonly']
		: ['full', 'readonly'];

	// A leading '' is the "(default)" entry - the agent's own configured model.
	const modelOptions = availableModels.includes('') ? availableModels : ['', ...availableModels];

	return (
		<PhoneBottomSheet
			open={open}
			onClose={onClose}
			theme={theme}
			ariaLabel="Composer options"
			// Half the screen, per the brief: enough that an expanded model list is
			// usable without the sheet swallowing the conversation behind it.
			maxHeight="50dvh"
			// Opened by a plain tap, so no synthesized click trails the gesture and
			// the scrim can be live immediately.
			scrimArmMs={0}
			testId="composer-options-sheet"
		>
			{onToggleTabSaveToHistory && (
				<button
					type="button"
					onClick={onToggleTabSaveToHistory}
					className="flex w-full items-center gap-3 px-4 text-left border-b"
					style={{ minHeight: 52, borderColor: theme.colors.border, color: theme.colors.textMain }}
					role="switch"
					aria-checked={tabSaveToHistory}
					data-testid="composer-options-history"
				>
					<History
						className="w-4 h-4 shrink-0"
						style={{ color: tabSaveToHistory ? theme.colors.accent : theme.colors.textDim }}
					/>
					<span className="text-sm flex-1 min-w-0">History</span>
					<span
						className="text-xs font-mono"
						style={{ color: tabSaveToHistory ? theme.colors.accent : theme.colors.textDim }}
					>
						{tabSaveToHistory ? 'On' : 'Off'}
					</span>
				</button>
			)}

			{hasReadOnlyCapability && (
				<OptionSection
					icon={Eye}
					label="Access"
					value={getPermissionModeLabel(permissionMode, agentId)}
					accent={permissionMode === 'readonly' ? theme.colors.warning : theme.colors.accent}
					expanded={expanded === 'access'}
					onToggle={() => toggle('access')}
					theme={theme}
					testId="composer-options-access"
				>
					{permissionModes.map((mode) => (
						<OptionRow
							key={mode}
							label={getPermissionModeLabel(mode, agentId)}
							selected={mode === permissionMode}
							accent={mode === 'readonly' ? theme.colors.warning : theme.colors.accent}
							onSelect={() => onPermissionModeChange(mode)}
							theme={theme}
						/>
					))}
				</OptionSection>
			)}

			{supportsThinking && onThinkingModeChange && (
				<OptionSection
					icon={Brain}
					label="Thinking"
					value={THINKING_LABELS[tabShowThinking]}
					accent={tabShowThinking === 'sticky' ? theme.colors.warning : theme.colors.accentText}
					expanded={expanded === 'thinking'}
					onToggle={() => toggle('thinking')}
					theme={theme}
					testId="composer-options-thinking"
				>
					{THINKING_MODES.map((mode) => (
						<OptionRow
							key={mode}
							label={THINKING_LABELS[mode]}
							selected={mode === tabShowThinking}
							accent={mode === 'sticky' ? theme.colors.warning : theme.colors.accentText}
							onSelect={() => onThinkingModeChange(mode)}
							theme={theme}
						/>
					))}
				</OptionSection>
			)}

			{onEffortChange && availableEfforts.some((e) => e !== '') && (
				<OptionSection
					icon={Gauge}
					label="Effort"
					value={currentEffort || 'default'}
					accent={theme.colors.warning}
					expanded={expanded === 'effort'}
					onToggle={() => toggle('effort')}
					theme={theme}
					testId="composer-options-effort"
				>
					{availableEfforts.map((effort) => (
						<OptionRow
							key={effort || '__default__'}
							label={effort || '(default)'}
							selected={effort === currentEffort}
							accent={theme.colors.warning}
							onSelect={() => onEffortChange(effort)}
							theme={theme}
						/>
					))}
				</OptionSection>
			)}

			{onModelChange && availableModels.length > 0 && (
				<OptionSection
					icon={Sparkles}
					label="Model"
					value={currentModel || 'default'}
					accent={theme.colors.accent}
					expanded={expanded === 'model'}
					onToggle={() => toggle('model')}
					theme={theme}
					testId="composer-options-model"
				>
					{modelOptions.map((model) => (
						<OptionRow
							key={model || '__default__'}
							label={model || '(default)'}
							selected={model === currentModel}
							accent={theme.colors.accent}
							onSelect={() => onModelChange(model)}
							theme={theme}
						/>
					))}
				</OptionSection>
			)}
		</PhoneBottomSheet>
	);
});
