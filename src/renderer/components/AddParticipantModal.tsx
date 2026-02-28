/**
 * AddParticipantModal.tsx
 *
 * Modal for adding a participant to an existing Group Chat.
 * Provides two options:
 * 1. "Use existing session" — picks from sidebar sessions, inherits config
 * 2. "Create fresh agent" — picks an agent type, spawns with defaults
 */

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Theme, Session, AgentConfig, GroupChatParticipant } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui';
import { AGENT_TILES } from './Wizard/screens/AgentSelectionScreen';

type ParticipantMode = 'fresh' | 'existing';

interface AddParticipantModalProps {
	theme: Theme;
	isOpen: boolean;
	sessions: Session[];
	participants: GroupChatParticipant[];
	onClose: () => void;
	onAddExisting: (name: string, agentId: string, cwd: string) => void;
	onAddFresh: (agentId: string, name: string) => void;
}

export function AddParticipantModal({
	theme,
	isOpen,
	sessions,
	participants,
	onClose,
	onAddExisting,
	onAddFresh,
}: AddParticipantModalProps): JSX.Element | null {
	const [mode, setMode] = useState<ParticipantMode>('fresh');
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [detectedAgents, setDetectedAgents] = useState<AgentConfig[]>([]);
	const [isDetecting, setIsDetecting] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Reset state when modal closes
	useEffect(() => {
		if (!isOpen) {
			setMode('fresh');
			setSelectedSessionId(null);
			setSelectedAgentId(null);
			setIsDetecting(true);
			setError(null);
			setIsSubmitting(false);
			return;
		}

		// Detect agents on open
		async function detect() {
			try {
				const agents = await window.maestro.agents.detect();
				const available = agents.filter((a: AgentConfig) => a.available && !a.hidden);
				setDetectedAgents(available);

				// Auto-select first available supported agent
				const firstSupported = AGENT_TILES.find(
					(tile) => tile.supported && available.some((a: AgentConfig) => a.id === tile.id)
				);
				if (firstSupported) {
					setSelectedAgentId(firstSupported.id);
				} else if (available.length > 0) {
					setSelectedAgentId(available[0].id);
				}
			} catch (err) {
				setError('Failed to detect available agents. Please try again.');
			} finally {
				setIsDetecting(false);
			}
		}

		detect();
	}, [isOpen]);

	// Filter sessions: exclude terminals and already-added participants
	const availableSessions = sessions.filter((s) => {
		// Exclude terminal sessions
		if (s.toolType === 'terminal') return false;
		// Exclude sessions already added as participants
		if (participants.some((p) => p.sessionId === s.id)) return false;
		return true;
	});

	// Auto-select first available session when switching to existing mode
	useEffect(() => {
		if (mode === 'existing' && !selectedSessionId && availableSessions.length > 0) {
			setSelectedSessionId(availableSessions[0].id);
		}
	}, [mode, selectedSessionId, availableSessions]);

	// Available agent tiles (supported + detected)
	const availableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return detectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});

	const handleSubmit = useCallback(async () => {
		setError(null);
		setIsSubmitting(true);

		try {
			if (mode === 'existing') {
				if (!selectedSessionId) {
					setIsSubmitting(false);
					return;
				}
				const session = sessions.find((s) => s.id === selectedSessionId);
				if (!session) {
					setIsSubmitting(false);
					return;
				}
				onAddExisting(session.name, session.toolType, session.cwd);
			} else {
				if (!selectedAgentId) {
					setIsSubmitting(false);
					return;
				}
				const tile = AGENT_TILES.find((t) => t.id === selectedAgentId);
				const name = tile?.name || selectedAgentId;
				onAddFresh(selectedAgentId, name);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add participant');
			setIsSubmitting(false);
			return;
		}
	}, [mode, selectedSessionId, selectedAgentId, sessions, onAddExisting, onAddFresh]);

	const canSubmit =
		!isSubmitting &&
		((mode === 'existing' && selectedSessionId !== null) ||
			(mode === 'fresh' && selectedAgentId !== null));

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Add Participant"
			priority={MODAL_PRIORITIES.ADD_GROUP_CHAT_PARTICIPANT}
			onClose={onClose}
			width={480}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSubmit}
					confirmLabel="Add"
					confirmDisabled={!canSubmit}
				/>
			}
		>
			<div>
				{/* Radio options */}
				<div className="space-y-3 mb-5">
					{/* Fresh agent option */}
					<label
						className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
						style={{
							borderColor: mode === 'fresh' ? theme.colors.accent : theme.colors.border,
							backgroundColor: mode === 'fresh' ? `${theme.colors.accent}08` : 'transparent',
						}}
					>
						<input
							type="radio"
							name="participantMode"
							value="fresh"
							checked={mode === 'fresh'}
							onChange={() => setMode('fresh')}
							className="mt-0.5"
							style={{ accentColor: theme.colors.accent }}
						/>
						<div className="flex-1">
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Create fresh agent
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Clean slate with default config, no prior context
							</div>
						</div>
					</label>

					{/* Existing session option */}
					<label
						className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
						style={{
							borderColor: mode === 'existing' ? theme.colors.accent : theme.colors.border,
							backgroundColor: mode === 'existing' ? `${theme.colors.accent}08` : 'transparent',
						}}
					>
						<input
							type="radio"
							name="participantMode"
							value="existing"
							checked={mode === 'existing'}
							onChange={() => setMode('existing')}
							className="mt-0.5"
							style={{ accentColor: theme.colors.accent }}
						/>
						<div className="flex-1">
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Use existing session
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Inherits working directory, model, and configuration
							</div>
						</div>
					</label>
				</div>

				{/* Dropdown area */}
				{mode === 'fresh' && (
					<div>
						<label
							className="block text-xs font-bold opacity-70 uppercase mb-2"
							style={{ color: theme.colors.textMain }}
						>
							Agent Type
						</label>
						{isDetecting ? (
							<div className="flex items-center gap-2 py-2">
								<div
									className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
									style={{
										borderColor: theme.colors.accent,
										borderTopColor: 'transparent',
									}}
								/>
								<span className="text-sm" style={{ color: theme.colors.textDim }}>
									Detecting agents...
								</span>
							</div>
						) : availableTiles.length === 0 ? (
							<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
								No agents available.
							</div>
						) : (
							<div className="relative">
								<select
									value={selectedAgentId || ''}
									onChange={(e) => setSelectedAgentId(e.target.value)}
									className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
									aria-label="Select agent type"
								>
									{availableTiles.map((tile) => (
										<option key={tile.id} value={tile.id}>
											{tile.name}
										</option>
									))}
								</select>
								<ChevronDown
									className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
									style={{ color: theme.colors.textDim }}
								/>
							</div>
						)}
					</div>
				)}

				{mode === 'existing' && (
					<div>
						<label
							className="block text-xs font-bold opacity-70 uppercase mb-2"
							style={{ color: theme.colors.textMain }}
						>
							Session
						</label>
						{availableSessions.length === 0 ? (
							<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
								No available sessions. All sessions are either terminals or already added.
							</div>
						) : (
							<div className="relative">
								<select
									value={selectedSessionId || ''}
									onChange={(e) => setSelectedSessionId(e.target.value)}
									className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
									aria-label="Select existing session"
								>
									{availableSessions.map((session) => {
										const tile = AGENT_TILES.find((t) => t.id === session.toolType);
										return (
											<option key={session.id} value={session.id}>
												{session.name} ({tile?.name || session.toolType}) — {session.cwd}
											</option>
										);
									})}
								</select>
								<ChevronDown
									className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
									style={{ color: theme.colors.textDim }}
								/>
							</div>
						)}
					</div>
				)}

				{/* Error display */}
				{error && (
					<div
						className="mt-3 text-xs p-3 rounded"
						style={{
							backgroundColor: `${theme.colors.error}20`,
							color: theme.colors.error,
							border: `1px solid ${theme.colors.error}40`,
						}}
					>
						{error}
					</div>
				)}
			</div>
		</Modal>
	);
}
