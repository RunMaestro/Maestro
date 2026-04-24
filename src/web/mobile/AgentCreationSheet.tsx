/**
 * AgentCreationSheet component for Maestro mobile web interface
 *
 * Uses `ResponsiveModal` so it renders as a bottom sheet on phones and a
 * centered dialog at tablet+. The "Create Agent" primary action lives in the
 * modal footer — always visible above the scrolling form and thumb-reachable
 * on mobile.
 */

import { useState, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { ResponsiveModal, Button } from '../components';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { GroupData } from '../hooks/useWebSocket';

/** Agent types available for creation from the web interface */
const CREATABLE_AGENT_TYPES = [
	{ id: 'claude-code', name: 'Claude Code', emoji: '🤖' },
	{ id: 'codex', name: 'Codex', emoji: '📦' },
	{ id: 'opencode', name: 'OpenCode', emoji: '🔓' },
	{ id: 'factory-droid', name: 'Factory Droid', emoji: '🏭' },
] as const;

export interface AgentCreationSheetProps {
	isOpen: boolean;
	groups: GroupData[];
	defaultCwd: string;
	createAgent: (
		name: string,
		toolType: string,
		cwd: string,
		groupId?: string
	) => Promise<{ sessionId: string } | null>;
	onCreated: (sessionId: string) => void;
	onClose: () => void;
}

export function AgentCreationSheet({
	isOpen,
	groups,
	defaultCwd,
	createAgent,
	onCreated,
	onClose,
}: AgentCreationSheetProps) {
	const colors = useThemeColors();
	const [selectedType, setSelectedType] = useState<string>('claude-code');
	const [name, setName] = useState('');
	const [cwd, setCwd] = useState(defaultCwd);
	const [groupId, setGroupId] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSelectType = useCallback((typeId: string) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setSelectedType(typeId);
		// Update default name when type changes
		const agentType = CREATABLE_AGENT_TYPES.find((t) => t.id === typeId);
		if (agentType) {
			setName('');
		}
	}, []);

	const getDefaultName = useCallback(() => {
		const agentType = CREATABLE_AGENT_TYPES.find((t) => t.id === selectedType);
		return agentType ? agentType.name : 'New Agent';
	}, [selectedType]);

	const handleCreate = useCallback(async () => {
		if (isSubmitting) return;
		const agentName = name.trim() || getDefaultName();
		if (!cwd.trim()) return;

		setIsSubmitting(true);
		triggerHaptic(HAPTIC_PATTERNS.send);

		try {
			const result = await createAgent(agentName, selectedType, cwd.trim(), groupId || undefined);
			if (result) {
				triggerHaptic(HAPTIC_PATTERNS.success);
				onCreated(result.sessionId);
				onClose();
			} else {
				triggerHaptic(HAPTIC_PATTERNS.error);
				setIsSubmitting(false);
			}
		} catch {
			triggerHaptic(HAPTIC_PATTERNS.error);
			setIsSubmitting(false);
		}
	}, [
		isSubmitting,
		name,
		getDefaultName,
		cwd,
		selectedType,
		groupId,
		createAgent,
		onCreated,
		onClose,
	]);

	const createDisabled = isSubmitting || !cwd.trim();

	return (
		<ResponsiveModal
			isOpen={isOpen}
			onClose={onClose}
			title="Create Agent"
			zIndex={220}
			footer={
				<Button
					variant="primary"
					fullWidth
					size="lg"
					onClick={handleCreate}
					disabled={createDisabled}
					aria-label="Create Agent"
				>
					{isSubmitting ? 'Creating...' : 'Create Agent'}
				</Button>
			}
		>
			{/* Agent type selector */}
			<div style={{ marginBottom: '20px' }}>
				<span
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '10px',
					}}
				>
					Agent Type
				</span>
				<div
					style={{
						display: 'flex',
						gap: '8px',
						overflowX: 'auto',
						paddingBottom: '4px',
					}}
				>
					{CREATABLE_AGENT_TYPES.map((agentType) => {
						const isSelected = selectedType === agentType.id;
						return (
							<button
								key={agentType.id}
								onClick={() => handleSelectType(agentType.id)}
								style={{
									display: 'flex',
									flexDirection: 'column',
									alignItems: 'center',
									gap: '6px',
									padding: '12px 14px',
									borderRadius: '10px',
									border: `2px solid ${isSelected ? colors.accent : colors.border}`,
									backgroundColor: isSelected ? `${colors.accent}10` : colors.bgSidebar,
									color: colors.textMain,
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									outline: 'none',
									minWidth: '80px',
									minHeight: '44px',
									flexShrink: 0,
									transition: 'all 0.15s ease',
								}}
								aria-label={`Select ${agentType.name}`}
								aria-pressed={isSelected}
							>
								<span style={{ fontSize: '24px' }}>{agentType.emoji}</span>
								<span
									style={{
										fontSize: '11px',
										fontWeight: isSelected ? 600 : 500,
										whiteSpace: 'nowrap',
									}}
								>
									{agentType.name}
								</span>
							</button>
						);
					})}
				</div>
			</div>

			{/* Name input */}
			<div style={{ marginBottom: '20px' }}>
				<label
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '8px',
					}}
				>
					Agent Name
				</label>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={getDefaultName()}
					style={{
						width: '100%',
						padding: '12px 14px',
						borderRadius: '10px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						color: colors.textMain,
						fontSize: '14px',
						outline: 'none',
						WebkitAppearance: 'none',
						boxSizing: 'border-box',
						minHeight: '44px',
					}}
					onFocus={(e) => {
						(e.target as HTMLInputElement).style.borderColor = colors.accent;
					}}
					onBlur={(e) => {
						(e.target as HTMLInputElement).style.borderColor = colors.border;
					}}
				/>
			</div>

			{/* Working directory */}
			<div style={{ marginBottom: '20px' }}>
				<label
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '8px',
					}}
				>
					Working Directory
				</label>
				<input
					type="text"
					value={cwd}
					onChange={(e) => setCwd(e.target.value)}
					placeholder="/path/to/project"
					style={{
						width: '100%',
						padding: '12px 14px',
						borderRadius: '10px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						color: colors.textMain,
						fontSize: '14px',
						outline: 'none',
						WebkitAppearance: 'none',
						boxSizing: 'border-box',
						fontFamily: 'monospace',
						minHeight: '44px',
					}}
					onFocus={(e) => {
						(e.target as HTMLInputElement).style.borderColor = colors.accent;
					}}
					onBlur={(e) => {
						(e.target as HTMLInputElement).style.borderColor = colors.border;
					}}
				/>
			</div>

			{/* Group selector */}
			<div>
				<label
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '8px',
					}}
				>
					Group (optional)
				</label>
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '6px',
					}}
				>
					{/* No group option */}
					<button
						onClick={() => {
							triggerHaptic(HAPTIC_PATTERNS.tap);
							setGroupId(null);
						}}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '10px',
							padding: '12px 14px',
							borderRadius: '10px',
							border: `1px solid ${groupId === null ? colors.accent : colors.border}`,
							backgroundColor: groupId === null ? `${colors.accent}10` : colors.bgSidebar,
							color: colors.textMain,
							width: '100%',
							textAlign: 'left',
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							outline: 'none',
							minHeight: '44px',
						}}
						aria-pressed={groupId === null}
					>
						<span style={{ fontSize: '14px', fontWeight: 500 }}>No group</span>
					</button>
					{groups.map((group) => {
						const isSelected = groupId === group.id;
						return (
							<button
								key={group.id}
								onClick={() => {
									triggerHaptic(HAPTIC_PATTERNS.tap);
									setGroupId(group.id);
								}}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: '10px',
									padding: '12px 14px',
									borderRadius: '10px',
									border: `1px solid ${isSelected ? colors.accent : colors.border}`,
									backgroundColor: isSelected ? `${colors.accent}10` : colors.bgSidebar,
									color: colors.textMain,
									width: '100%',
									textAlign: 'left',
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									outline: 'none',
									minHeight: '44px',
								}}
								aria-pressed={isSelected}
							>
								{group.emoji && <span style={{ fontSize: '16px' }}>{group.emoji}</span>}
								<span style={{ fontSize: '14px', fontWeight: 500 }}>{group.name}</span>
							</button>
						);
					})}
				</div>
			</div>
		</ResponsiveModal>
	);
}

export default AgentCreationSheet;
