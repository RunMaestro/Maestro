import { memo, useState, useMemo } from 'react';
import { Bot, Search, X } from 'lucide-react';
import type { Theme } from '../../../types';

export interface AgentSessionInfo {
	id: string;
	groupId?: string;
	name: string;
	toolType: string;
}

export interface AgentDrawerProps {
	isOpen: boolean;
	onClose: () => void;
	sessions: AgentSessionInfo[];
	groups?: { id: string; name: string; emoji: string }[];
	onCanvasSessionIds?: Set<string>;
	theme: Theme;
}

function handleDragStart(e: React.DragEvent, session: AgentSessionInfo) {
	e.dataTransfer.setData(
		'application/cue-pipeline',
		JSON.stringify({
			type: 'agent',
			sessionId: session.id,
			sessionName: session.name,
			toolType: session.toolType,
		})
	);
	e.dataTransfer.effectAllowed = 'move';
}

export const AgentDrawer = memo(function AgentDrawer({
	isOpen,
	onClose,
	sessions,
	groups,
	onCanvasSessionIds,
	theme,
}: AgentDrawerProps) {
	const [search, setSearch] = useState('');

	const filtered = useMemo(() => {
		if (!search.trim()) return sessions;
		const q = search.toLowerCase();
		return sessions.filter(
			(s) => s.name.toLowerCase().includes(q) || s.toolType.toLowerCase().includes(q)
		);
	}, [sessions, search]);

	// Build group lookup
	const groupMap = useMemo(() => {
		const map = new Map<string, { name: string; emoji: string }>();
		for (const g of groups ?? []) {
			map.set(g.id, { name: g.name, emoji: g.emoji });
		}
		return map;
	}, [groups]);

	// Group by user-defined groups (matching left panel), ungrouped last
	const grouped = useMemo(() => {
		const result = new Map<string, { label: string; sessions: AgentSessionInfo[] }>();
		for (const s of filtered) {
			const key = s.groupId ?? '__ungrouped__';
			if (!result.has(key)) {
				const g = s.groupId ? groupMap.get(s.groupId) : undefined;
				const label = g ? `${g.emoji} ${g.name}` : 'Ungrouped';
				result.set(key, { label, sessions: [] });
			}
			result.get(key)!.sessions.push(s);
		}
		return result;
	}, [filtered, groupMap]);

	return (
		<div
			style={{
				position: 'absolute',
				right: 0,
				top: 0,
				bottom: 0,
				width: 240,
				zIndex: 20,
				backgroundColor: theme.colors.bgMain,
				borderLeft: `1px solid ${theme.colors.border}`,
				transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
				transition: 'transform 200ms ease',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '10px 12px',
					borderBottom: `1px solid ${theme.colors.border}`,
					flexShrink: 0,
				}}
			>
				<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>Agents</span>
				<button
					onClick={onClose}
					style={{
						background: 'none',
						border: 'none',
						cursor: 'pointer',
						padding: 2,
						display: 'flex',
						alignItems: 'center',
						color: theme.colors.textDim,
					}}
				>
					<X size={14} />
				</button>
			</div>

			{/* Search */}
			<div style={{ padding: '8px 12px 4px', flexShrink: 0 }}>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 6,
						backgroundColor: theme.colors.bgActivity,
						borderRadius: 6,
						padding: '4px 8px',
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<Search size={12} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search agents..."
						style={{
							flex: 1,
							background: 'none',
							border: 'none',
							outline: 'none',
							color: theme.colors.textMain,
							fontSize: 12,
						}}
					/>
				</div>
			</div>

			{/* Agent list */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
				{Array.from(grouped.entries()).map(([key, { label, sessions: agents }]) => (
					<div key={key}>
						{grouped.size > 1 && (
							<div
								style={{
									color: theme.colors.textDim,
									fontSize: 10,
									fontWeight: 600,
									textTransform: 'uppercase',
									letterSpacing: '0.05em',
									padding: '8px 4px 4px',
								}}
							>
								{label}
							</div>
						)}
						{agents.map((session) => {
							const isOnCanvas = onCanvasSessionIds?.has(session.id) ?? false;
							return (
								<div
									key={session.id}
									draggable
									onDragStart={(e) => handleDragStart(e, session)}
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 8,
										padding: '8px 10px',
										marginBottom: 4,
										borderRadius: 6,
										backgroundColor: theme.colors.bgActivity,
										cursor: 'grab',
										transition: 'filter 0.15s',
									}}
									onMouseEnter={(e) => {
										(e.currentTarget as HTMLElement).style.filter = 'brightness(1.2)';
									}}
									onMouseLeave={(e) => {
										(e.currentTarget as HTMLElement).style.filter = 'brightness(1)';
									}}
								>
									<Bot size={14} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
									<div style={{ flex: 1, minWidth: 0 }}>
										<div
											style={{
												color: theme.colors.textMain,
												fontSize: 12,
												fontWeight: 500,
												whiteSpace: 'nowrap',
												overflow: 'hidden',
												textOverflow: 'ellipsis',
											}}
										>
											{session.name}
										</div>
										<div style={{ color: theme.colors.textDim, fontSize: 10 }}>
											{session.toolType}
										</div>
									</div>
									{isOnCanvas && (
										<div
											style={{
												width: 6,
												height: 6,
												borderRadius: '50%',
												backgroundColor: '#22c55e',
												flexShrink: 0,
											}}
											title="On canvas"
										/>
									)}
								</div>
							);
						})}
					</div>
				))}
				{filtered.length === 0 && (
					<div
						style={{
							color: theme.colors.textDim,
							fontSize: 12,
							textAlign: 'center',
							padding: '20px 0',
						}}
					>
						{search ? 'No agents match' : 'No agents available'}
					</div>
				)}
			</div>
		</div>
	);
});
