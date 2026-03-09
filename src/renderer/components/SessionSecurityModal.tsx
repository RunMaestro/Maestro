/**
 * SessionSecurityModal - Per-session LLM Guard security policy configuration
 *
 * Allows users to override global LLM Guard settings for specific sessions.
 * Use cases:
 * - Stricter settings for sensitive projects
 * - Relaxed settings for internal/test projects
 * - Different ban lists per project
 *
 * When a setting is not overridden, it inherits from global settings.
 */

import React, { useState, useCallback, memo } from 'react';
import {
	Shield,
	ShieldAlert,
	ShieldCheck,
	ShieldX,
	AlertTriangle,
	Eye,
	Lock,
	RotateCcw,
	Check,
	Link,
	Code,
} from 'lucide-react';
import type { Theme, Session, LlmGuardSettings, LlmGuardAction } from '../types';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ToggleButtonGroup } from './ToggleButtonGroup';
import { useSettings } from '../hooks';

interface SessionSecurityModalProps {
	theme: Theme;
	session: Session;
	onClose: () => void;
	onSave: (sessionId: string, securityPolicy: Partial<LlmGuardSettings> | undefined) => void;
}

/**
 * Checkbox that shows inheritance state
 */
function OverrideCheckbox({
	label,
	checked,
	inherited,
	inheritedValue,
	onChange,
	theme,
	disabled,
}: {
	label: string;
	checked: boolean;
	inherited: boolean;
	inheritedValue: boolean;
	onChange: (checked: boolean) => void;
	theme: Theme;
	disabled?: boolean;
}) {
	const effectiveValue = inherited ? inheritedValue : checked;

	return (
		<label className={`flex items-center gap-2 py-1 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
			<input
				type="checkbox"
				checked={effectiveValue}
				onChange={(e) => onChange(e.target.checked)}
				disabled={disabled}
				className="w-4 h-4 rounded accent-current"
				style={{ accentColor: theme.colors.accent }}
			/>
			<span className="text-sm" style={{ color: theme.colors.textMain }}>
				{label}
			</span>
			{inherited && (
				<span
					className="text-[10px] px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					inherited
				</span>
			)}
		</label>
	);
}

export const SessionSecurityModal = memo(function SessionSecurityModal({
	theme,
	session,
	onClose,
	onSave,
}: SessionSecurityModalProps) {
	const { llmGuardSettings: globalSettings } = useSettings();

	// Initialize state from session's existing policy or empty (inherit all)
	const [policy, setPolicy] = useState<Partial<LlmGuardSettings>>(
		session.securityPolicy ? { ...session.securityPolicy } : {}
	);

	// Track which settings are overridden (not inherited)
	const isOverridden = useCallback(
		(key: keyof LlmGuardSettings | string): boolean => {
			if (key === 'enabled' || key === 'action') {
				return policy[key as keyof LlmGuardSettings] !== undefined;
			}
			if (key.startsWith('input.')) {
				const inputKey = key.replace('input.', '') as keyof LlmGuardSettings['input'];
				return policy.input?.[inputKey] !== undefined;
			}
			if (key.startsWith('output.')) {
				const outputKey = key.replace('output.', '') as keyof LlmGuardSettings['output'];
				return policy.output?.[outputKey] !== undefined;
			}
			if (key.startsWith('thresholds.')) {
				const thresholdKey = key.replace('thresholds.', '') as keyof LlmGuardSettings['thresholds'];
				return policy.thresholds?.[thresholdKey] !== undefined;
			}
			return false;
		},
		[policy]
	);

	const handleToggleEnabled = useCallback(() => {
		const currentValue = policy.enabled ?? globalSettings.enabled;
		setPolicy((prev) => ({
			...prev,
			enabled: !currentValue,
		}));
	}, [policy.enabled, globalSettings.enabled]);

	const handleActionChange = useCallback((action: LlmGuardAction) => {
		setPolicy((prev) => ({
			...prev,
			action,
		}));
	}, []);

	const handleInputToggle = useCallback(
		(key: keyof LlmGuardSettings['input']) => {
			const currentValue = policy.input?.[key] ?? globalSettings.input[key];
			setPolicy((prev) => ({
				...prev,
				input: {
					...(prev.input || {}),
					[key]: !currentValue,
				} as LlmGuardSettings['input'],
			}));
		},
		[policy.input, globalSettings.input]
	);

	const handleOutputToggle = useCallback(
		(key: keyof LlmGuardSettings['output']) => {
			const currentValue = policy.output?.[key] ?? globalSettings.output[key];
			setPolicy((prev) => ({
				...prev,
				output: {
					...(prev.output || {}),
					[key]: !currentValue,
				} as LlmGuardSettings['output'],
			}));
		},
		[policy.output, globalSettings.output]
	);

	const handleThresholdChange = useCallback((value: number) => {
		setPolicy((prev) => ({
			...prev,
			thresholds: {
				...(prev.thresholds || {}),
				promptInjection: value,
			},
		}));
	}, []);

	const handleResetToGlobal = useCallback(() => {
		setPolicy({});
	}, []);

	const handleSave = useCallback(() => {
		// If no overrides, save undefined (inherit all)
		const hasOverrides = Object.keys(policy).length > 0;
		onSave(session.id, hasOverrides ? policy : undefined);
		onClose();
	}, [session.id, policy, onSave, onClose]);

	// Get effective values for display
	const effectiveEnabled = policy.enabled ?? globalSettings.enabled;
	const effectiveAction = policy.action ?? globalSettings.action;

	// Check if there are any overrides
	const hasAnyOverrides = Object.keys(policy).length > 0;

	const actionOptions = [
		{
			value: 'warn' as const,
			label: 'Warn',
			icon: <AlertTriangle className="w-3 h-3" />,
			tooltip: 'Show warning but allow message',
		},
		{
			value: 'sanitize' as const,
			label: 'Sanitize',
			icon: <Eye className="w-3 h-3" />,
			tooltip: 'Remove sensitive content automatically',
		},
		{
			value: 'block' as const,
			label: 'Block',
			icon: <Lock className="w-3 h-3" />,
			tooltip: 'Block messages with detected issues',
		},
	];

	return (
		<Modal
			theme={theme}
			title="Session Security Settings"
			priority={MODAL_PRIORITIES.SESSION_SECURITY}
			onClose={onClose}
			headerIcon={<Shield className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={500}
			maxHeight="80vh"
			footer={
				<ModalFooter theme={theme} onCancel={onClose} onConfirm={handleSave} confirmLabel="Save" />
			}
		>
			<div className="space-y-4 overflow-y-auto pr-2">
				{/* Session Info */}
				<div
					className="p-3 rounded-lg border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<p className="text-sm" style={{ color: theme.colors.textMain }}>
						<span className="font-medium">Agent:</span> {session.name}
					</p>
					<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						Override global LLM Guard settings for this agent. Unset options inherit from global
						settings.
					</p>
				</div>

				{/* Reset to Global Button */}
				{hasAnyOverrides && (
					<button
						type="button"
						onClick={handleResetToGlobal}
						className="flex items-center gap-2 px-3 py-1.5 rounded text-xs hover:bg-white/5 transition-colors"
						style={{ color: theme.colors.accent }}
					>
						<RotateCcw className="w-3 h-3" />
						Reset all to global settings
					</button>
				)}

				{/* Master Toggle */}
				<div
					className="p-3 rounded-lg border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							{effectiveEnabled ? (
								<ShieldCheck className="w-5 h-5" style={{ color: theme.colors.success }} />
							) : (
								<ShieldX className="w-5 h-5" style={{ color: theme.colors.textDim }} />
							)}
							<div>
								<span className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
									LLM Guard
								</span>
								{!isOverridden('enabled') && (
									<span
										className="ml-2 text-[10px] px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textDim,
										}}
									>
										inherited
									</span>
								)}
							</div>
						</div>
						<button
							type="button"
							onClick={handleToggleEnabled}
							className={`relative w-10 h-5 rounded-full transition-colors ${effectiveEnabled ? 'bg-green-500' : 'bg-gray-600'}`}
						>
							<span
								className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${effectiveEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}
							/>
						</button>
					</div>
				</div>

				{/* Action Mode */}
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Action Mode
						</span>
						{!isOverridden('action') && (
							<span
								className="text-[10px] px-1.5 py-0.5 rounded"
								style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
							>
								inherited
							</span>
						)}
					</div>
					<ToggleButtonGroup
						theme={theme}
						options={actionOptions}
						value={effectiveAction}
						onChange={handleActionChange}
						disabled={!effectiveEnabled}
					/>
				</div>

				{/* Input Protection */}
				<div
					className="p-3 rounded-lg border space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<ShieldAlert className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Input Protection
						</span>
					</div>
					<div className="ml-6 space-y-1">
						<OverrideCheckbox
							label="Anonymize PII"
							checked={policy.input?.anonymizePii ?? false}
							inherited={!isOverridden('input.anonymizePii')}
							inheritedValue={globalSettings.input.anonymizePii}
							onChange={() => handleInputToggle('anonymizePii')}
							theme={theme}
							disabled={!effectiveEnabled}
						/>
						<OverrideCheckbox
							label="Redact Secrets"
							checked={policy.input?.redactSecrets ?? false}
							inherited={!isOverridden('input.redactSecrets')}
							inheritedValue={globalSettings.input.redactSecrets}
							onChange={() => handleInputToggle('redactSecrets')}
							theme={theme}
							disabled={!effectiveEnabled}
						/>
						<OverrideCheckbox
							label="Detect Prompt Injection"
							checked={policy.input?.detectPromptInjection ?? false}
							inherited={!isOverridden('input.detectPromptInjection')}
							inheritedValue={globalSettings.input.detectPromptInjection}
							onChange={() => handleInputToggle('detectPromptInjection')}
							theme={theme}
							disabled={!effectiveEnabled}
						/>
						<div className="flex items-center gap-1">
							<Link className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							<OverrideCheckbox
								label="Scan URLs"
								checked={policy.input?.scanUrls ?? false}
								inherited={!isOverridden('input.scanUrls')}
								inheritedValue={globalSettings.input.scanUrls ?? true}
								onChange={() => handleInputToggle('scanUrls')}
								theme={theme}
								disabled={!effectiveEnabled}
							/>
						</div>
					</div>
				</div>

				{/* Output Protection */}
				<div
					className="p-3 rounded-lg border space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<Eye className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Output Protection
						</span>
					</div>
					<div className="ml-6 space-y-1">
						<OverrideCheckbox
							label="Deanonymize PII"
							checked={policy.output?.deanonymizePii ?? false}
							inherited={!isOverridden('output.deanonymizePii')}
							inheritedValue={globalSettings.output.deanonymizePii}
							onChange={() => handleOutputToggle('deanonymizePii')}
							theme={theme}
							disabled={!effectiveEnabled}
						/>
						<OverrideCheckbox
							label="Redact Secrets"
							checked={policy.output?.redactSecrets ?? false}
							inherited={!isOverridden('output.redactSecrets')}
							inheritedValue={globalSettings.output.redactSecrets}
							onChange={() => handleOutputToggle('redactSecrets')}
							theme={theme}
							disabled={!effectiveEnabled}
						/>
						<OverrideCheckbox
							label="Detect PII Leakage"
							checked={policy.output?.detectPiiLeakage ?? false}
							inherited={!isOverridden('output.detectPiiLeakage')}
							inheritedValue={globalSettings.output.detectPiiLeakage}
							onChange={() => handleOutputToggle('detectPiiLeakage')}
							theme={theme}
							disabled={!effectiveEnabled}
						/>
						<div className="flex items-center gap-1">
							<Link className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							<OverrideCheckbox
								label="Scan URLs"
								checked={policy.output?.scanUrls ?? false}
								inherited={!isOverridden('output.scanUrls')}
								inheritedValue={globalSettings.output.scanUrls ?? true}
								onChange={() => handleOutputToggle('scanUrls')}
								theme={theme}
								disabled={!effectiveEnabled}
							/>
						</div>
						<div className="flex items-center gap-1">
							<Code className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							<OverrideCheckbox
								label="Scan Code Patterns"
								checked={policy.output?.scanCode ?? false}
								inherited={!isOverridden('output.scanCode')}
								inheritedValue={globalSettings.output.scanCode ?? true}
								onChange={() => handleOutputToggle('scanCode')}
								theme={theme}
								disabled={!effectiveEnabled}
							/>
						</div>
					</div>
				</div>

				{/* Threshold */}
				<div
					className="p-3 rounded-lg border space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Injection Detection Threshold
							</span>
							{!isOverridden('thresholds.promptInjection') && (
								<span
									className="text-[10px] px-1.5 py-0.5 rounded"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
								>
									inherited
								</span>
							)}
						</div>
						<span className="text-sm font-mono" style={{ color: theme.colors.accent }}>
							{(
								policy.thresholds?.promptInjection ?? globalSettings.thresholds.promptInjection
							).toFixed(2)}
						</span>
					</div>
					<input
						type="range"
						min="0"
						max="1"
						step="0.05"
						value={policy.thresholds?.promptInjection ?? globalSettings.thresholds.promptInjection}
						onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
						disabled={!effectiveEnabled}
						className="w-full accent-current"
						style={{ accentColor: theme.colors.accent }}
					/>
					<div className="flex justify-between text-[10px]" style={{ color: theme.colors.textDim }}>
						<span>More Sensitive</span>
						<span>Less Sensitive</span>
					</div>
				</div>

				{/* Status indicator */}
				<div
					className="flex items-center gap-2 p-2 rounded"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					{hasAnyOverrides ? (
						<>
							<Check className="w-4 h-4" style={{ color: theme.colors.success }} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{Object.keys(policy).length} setting(s) overridden for this session
							</span>
						</>
					) : (
						<>
							<Shield className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Using global security settings
							</span>
						</>
					)}
				</div>
			</div>
		</Modal>
	);
});

export default SessionSecurityModal;
