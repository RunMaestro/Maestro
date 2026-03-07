/**
 * NodeConfigPanel — Bottom panel for configuring selected trigger or agent nodes.
 *
 * Shows event-specific fields for triggers, prompt textarea for agents.
 * All changes update immediately (debounced for text inputs).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
	Trash2,
	Clock,
	FileText,
	Zap,
	GitPullRequest,
	GitBranch,
	CheckSquare,
	ExternalLink,
} from 'lucide-react';
import type {
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
	CueEventType,
	CuePipeline,
} from '../../../../shared/cue-pipeline-types';
import { useDebouncedCallback } from '../../../hooks/utils';

interface NodeConfigPanelProps {
	selectedNode: PipelineNode | null;
	pipelines: CuePipeline[];
	onUpdateNode: (nodeId: string, data: Partial<TriggerNodeData | AgentNodeData>) => void;
	onDeleteNode: (nodeId: string) => void;
	onSwitchToAgent?: (sessionId: string) => void;
}

const EVENT_ICONS: Record<CueEventType, typeof Clock> = {
	'time.interval': Clock,
	'file.changed': FileText,
	'agent.completed': Zap,
	'github.pull_request': GitPullRequest,
	'github.issue': GitBranch,
	'task.pending': CheckSquare,
};

const EVENT_LABELS: Record<CueEventType, string> = {
	'time.interval': 'Scheduled Timer',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Completed',
	'github.pull_request': 'Pull Request',
	'github.issue': 'GitHub Issue',
	'task.pending': 'Pending Task',
};

const inputStyle: React.CSSProperties = {
	backgroundColor: '#2a2a3e',
	border: '1px solid #444',
	borderRadius: 4,
	color: '#e4e4e7',
	padding: '4px 8px',
	fontSize: 12,
	outline: 'none',
	width: '100%',
};

const selectStyle: React.CSSProperties = {
	...inputStyle,
	cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
	color: '#9ca3af',
	fontSize: 11,
	fontWeight: 500,
	marginBottom: 4,
	display: 'block',
};

function TriggerConfig({
	node,
	onUpdateNode,
}: {
	node: PipelineNode;
	onUpdateNode: NodeConfigPanelProps['onUpdateNode'];
}) {
	const data = node.data as TriggerNodeData;
	const [localConfig, setLocalConfig] = useState(data.config);

	useEffect(() => {
		setLocalConfig(data.config);
	}, [data.config]);

	const { debouncedCallback: debouncedUpdate } = useDebouncedCallback((...args: unknown[]) => {
		const config = args[0] as TriggerNodeData['config'];
		onUpdateNode(node.id, { config } as Partial<TriggerNodeData>);
	}, 300);

	const updateConfig = useCallback(
		(key: string, value: string | number) => {
			const updated = { ...localConfig, [key]: value };
			setLocalConfig(updated);
			debouncedUpdate(updated);
		},
		[localConfig, debouncedUpdate]
	);

	const updateFilter = useCallback(
		(key: string, value: string) => {
			const updated = {
				...localConfig,
				filter: { ...(localConfig.filter ?? {}), [key]: value },
			};
			setLocalConfig(updated);
			debouncedUpdate(updated);
		},
		[localConfig, debouncedUpdate]
	);

	switch (data.eventType) {
		case 'time.interval':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<label style={labelStyle}>
						Run every N minutes
						<input
							type="number"
							min={1}
							value={localConfig.interval_minutes ?? ''}
							onChange={(e) => updateConfig('interval_minutes', parseInt(e.target.value) || 1)}
							placeholder="30"
							style={inputStyle}
						/>
					</label>
				</div>
			);
		case 'file.changed':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<label style={labelStyle}>
						Watch pattern
						<input
							type="text"
							value={localConfig.watch ?? ''}
							onChange={(e) => updateConfig('watch', e.target.value)}
							placeholder="**/*.ts"
							style={inputStyle}
						/>
					</label>
					<label style={labelStyle}>
						Change type
						<select
							value={(localConfig.filter?.changeType as string) ?? 'any'}
							onChange={(e) => updateFilter('changeType', e.target.value)}
							style={selectStyle}
						>
							<option value="any">Any</option>
							<option value="created">Created</option>
							<option value="modified">Modified</option>
							<option value="deleted">Deleted</option>
						</select>
					</label>
				</div>
			);
		case 'agent.completed':
			return (
				<div style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>
					Source agent is determined by incoming edges. Connect a trigger or agent node to configure
					the source.
				</div>
			);
		case 'github.pull_request':
		case 'github.issue':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<label style={labelStyle}>
						Repository
						<input
							type="text"
							value={localConfig.repo ?? ''}
							onChange={(e) => updateConfig('repo', e.target.value)}
							placeholder="owner/repo"
							style={inputStyle}
						/>
					</label>
					<label style={labelStyle}>
						Poll every N minutes
						<input
							type="number"
							min={1}
							value={localConfig.poll_minutes ?? ''}
							onChange={(e) => updateConfig('poll_minutes', parseInt(e.target.value) || 5)}
							placeholder="5"
							style={inputStyle}
						/>
					</label>
				</div>
			);
		case 'task.pending':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<label style={labelStyle}>
						Scan pattern
						<input
							type="text"
							value={localConfig.watch ?? ''}
							onChange={(e) => updateConfig('watch', e.target.value)}
							placeholder="**/*.md"
							style={inputStyle}
						/>
					</label>
				</div>
			);
		default:
			return null;
	}
}

function AgentConfig({
	node,
	pipelines,
	onUpdateNode,
	onSwitchToAgent,
}: {
	node: PipelineNode;
	pipelines: CuePipeline[];
	onUpdateNode: NodeConfigPanelProps['onUpdateNode'];
	onSwitchToAgent?: (sessionId: string) => void;
}) {
	const data = node.data as AgentNodeData;
	const [localPrompt, setLocalPrompt] = useState(data.prompt ?? '');
	const promptRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		setLocalPrompt(data.prompt ?? '');
	}, [data.prompt]);

	const { debouncedCallback: debouncedUpdate } = useDebouncedCallback((...args: unknown[]) => {
		const prompt = args[0] as string;
		onUpdateNode(node.id, { prompt } as Partial<AgentNodeData>);
	}, 300);

	const handlePromptChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalPrompt(e.target.value);
			debouncedUpdate(e.target.value);
		},
		[debouncedUpdate]
	);

	// Find which pipelines contain this agent
	const agentPipelines = pipelines.filter((p) =>
		p.nodes.some(
			(n) => n.type === 'agent' && (n.data as AgentNodeData).sessionId === data.sessionId
		)
	);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<label style={labelStyle}>
				System Prompt Extension
				<textarea
					ref={promptRef}
					value={localPrompt}
					onChange={handlePromptChange}
					rows={4}
					placeholder="Optional prompt appended when this agent receives data from the pipeline..."
					style={{
						...inputStyle,
						resize: 'vertical',
						fontFamily: 'inherit',
						lineHeight: 1.4,
					}}
				/>
			</label>
			<div style={{ color: '#6b7280', fontSize: 10, textAlign: 'right' }}>
				{localPrompt.length} characters
			</div>

			{agentPipelines.length > 0 && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
					{agentPipelines.map((p) => (
						<span
							key={p.id}
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: 4,
								fontSize: 11,
								color: '#9ca3af',
							}}
						>
							<span
								style={{
									width: 8,
									height: 8,
									borderRadius: '50%',
									backgroundColor: p.color,
									display: 'inline-block',
								}}
							/>
							{p.name}
						</span>
					))}
				</div>
			)}

			{onSwitchToAgent && (
				<button
					onClick={() => onSwitchToAgent(data.sessionId)}
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: 4,
						padding: '4px 10px',
						fontSize: 11,
						fontWeight: 500,
						color: '#06b6d4',
						backgroundColor: 'transparent',
						border: '1px solid #06b6d440',
						borderRadius: 4,
						cursor: 'pointer',
						alignSelf: 'flex-start',
						marginTop: 4,
					}}
				>
					<ExternalLink size={11} />
					Switch to Agent
				</button>
			)}
		</div>
	);
}

export function NodeConfigPanel({
	selectedNode,
	pipelines,
	onUpdateNode,
	onDeleteNode,
	onSwitchToAgent,
}: NodeConfigPanelProps) {
	const isVisible = selectedNode !== null;

	if (!isVisible) return null;

	const isTrigger = selectedNode.type === 'trigger';
	const triggerData = isTrigger ? (selectedNode.data as TriggerNodeData) : null;
	const agentData = !isTrigger ? (selectedNode.data as AgentNodeData) : null;

	const Icon = triggerData ? (EVENT_ICONS[triggerData.eventType] ?? Zap) : null;

	return (
		<div
			style={{
				position: 'absolute',
				bottom: 0,
				left: 0,
				right: 0,
				height: 200,
				backgroundColor: '#1a1a2e',
				borderTop: '1px solid #333',
				boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
				display: 'flex',
				flexDirection: 'column',
				zIndex: 10,
				animation: 'slideUp 0.15s ease-out',
			}}
		>
			<style>{`
				@keyframes slideUp {
					from { transform: translateY(100%); }
					to { transform: translateY(0); }
				}
			`}</style>

			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '8px 16px',
					borderBottom: '1px solid #2a2a3e',
					flexShrink: 0,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					{isTrigger && Icon && (
						<>
							<Icon size={14} style={{ color: '#f59e0b' }} />
							<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>
								Configure Trigger
							</span>
							<span
								style={{
									fontSize: 10,
									color: '#9ca3af',
									backgroundColor: '#2a2a3e',
									padding: '1px 6px',
									borderRadius: 4,
								}}
							>
								{EVENT_LABELS[triggerData!.eventType]}
							</span>
						</>
					)}
					{!isTrigger && agentData && (
						<>
							<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>
								{agentData.sessionName}
							</span>
							<span
								style={{
									fontSize: 10,
									color: '#9ca3af',
									backgroundColor: '#2a2a3e',
									padding: '1px 6px',
									borderRadius: 4,
								}}
							>
								{agentData.toolType}
							</span>
						</>
					)}
				</div>
				<button
					onClick={() => onDeleteNode(selectedNode.id)}
					style={{
						display: 'flex',
						alignItems: 'center',
						padding: 4,
						color: '#6b7280',
						backgroundColor: 'transparent',
						border: 'none',
						borderRadius: 4,
						cursor: 'pointer',
					}}
					onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
					onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
					title="Delete node"
				>
					<Trash2 size={14} />
				</button>
			</div>

			{/* Content */}
			<div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
				{isTrigger && <TriggerConfig node={selectedNode} onUpdateNode={onUpdateNode} />}
				{!isTrigger && (
					<AgentConfig
						node={selectedNode}
						pipelines={pipelines}
						onUpdateNode={onUpdateNode}
						onSwitchToAgent={onSwitchToAgent}
					/>
				)}
			</div>
		</div>
	);
}
