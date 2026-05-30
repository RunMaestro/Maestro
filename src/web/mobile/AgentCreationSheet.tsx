/**
 * AgentCreationSheet component for Maestro mobile web interface
 *
 * Bottom sheet modal for creating a new agent.
 * Allows selecting agent type, name, working directory, and optional group.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
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
	const [isVisible, setIsVisible] = useState(false);
	const nameInputRef = useRef<HTMLInputElement>(null);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	// Animate in on mount
	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

	const handleBackdropTap = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) {
				handleClose();
			}
		},
		[handleClose]
	);

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
				handleClose();
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
		handleClose,
	]);

	return (
		<div
			onClick={handleBackdropTap}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: `rgba(0, 0, 0, ${isVisible ? 0.5 : 0})`,
				zIndex: 220,
				display: 'flex',
				alignItems: 'flex-end',
				transition: 'background-color 0.3s ease-out',
			}}
		>
			{/* Sheet */}
			<div
				style={{
					width: '100%',
					maxHeight: '85vh',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.3s ease-out',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Drag handle */}
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						padding: '10px 0 4px',
						flexShrink: 0,
					}}
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}40`,
						}}
					/>
				</div>

				{/* Header */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '8px 16px 12px',
						flexShrink: 0,
					}}
				>
					<h2
						style={{
							fontSize: '18px',
							fontWeight: 600,
							margin: 0,
							color: colors.textMain,
						}}
					>
						Create Agent
					</h2>
					<button
						onClick={handleClose}
						style={{
							width: '44px',
							height: '44px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgSidebar,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Close creation sheet"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				{/* Scrollable content */}
				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						overflowX: 'hidden',
						padding: '0 16px',
					}}
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
							ref={nameInputRef}
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
				</div>

				{/* Create button */}
				<div
					style={{
						padding: '12px 16px 0',
						flexShrink: 0,
					}}
				>
					<button
						onClick={handleCreate}
						disabled={isSubmitting || !cwd.trim()}
						style={{
							width: '100%',
							padding: '14px 20px',
							borderRadius: '12px',
							backgroundColor: isSubmitting || !cwd.trim() ? `${colors.accent}40` : colors.accent,
							border: 'none',
							color: 'white',
							fontSize: '16px',
							fontWeight: 600,
							cursor: isSubmitting || !cwd.trim() ? 'not-allowed' : 'pointer',
							opacity: isSubmitting || !cwd.trim() ? 0.5 : 1,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							minHeight: '50px',
							transition: 'all 0.15s ease',
						}}
						aria-label="Create Agent"
					>
						{isSubmitting ? 'Creating...' : 'Create Agent'}
					</button>
				</div>
			</div>
		</div>
	);
}

export default AgentCreationSheet;
