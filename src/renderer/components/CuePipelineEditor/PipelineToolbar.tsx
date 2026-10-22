/**
 * PipelineToolbar - Toolbar with trigger/agent drawer toggles, pipeline selector,
 * settings toggle, save/discard buttons, and validation error bar.
 */

import React from 'react';
import { Zap, Bot, Save, RotateCcw, Check, AlertTriangle, X, ChevronLeft } from 'lucide-react';
import type { Theme } from '../../types';
import type { CuePipeline } from '../../../shared/cue-pipeline-types';
import { PipelineSelector } from './PipelineSelector';
import type { PipelineAgentScope } from './utils/pipelineMembership';

export interface PipelineToolbarProps {
	theme: Theme;
	isAllPipelinesView: boolean;
	triggerDrawerOpen: boolean;
	setTriggerDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	agentDrawerOpen: boolean;
	setAgentDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	// PipelineSelector props
	pipelines: CuePipeline[];
	selectedPipelineId: string | null;
	selectPipeline: (id: string | null) => void;
	createPipeline: () => void;
	deletePipeline: (id: string) => void;
	renamePipeline: (id: string, name: string) => void;
	changePipelineColor: (id: string, color: string) => void;
	// Save/discard
	isDirty: boolean;
	saveStatus: 'idle' | 'saving' | 'success' | 'error';
	handleSave: () => void;
	handleDiscard: () => void;
	validationErrors: string[];
	/** Agents the All Pipelines view can be narrowed to (selector's Agents section). */
	agentScopes?: PipelineAgentScope[];
	/** The agent All Pipelines is currently narrowed to, if any. */
	activeScope?: PipelineAgentScope | null;
	onSelectAgentScope?: (scope: PipelineAgentScope) => void;
	onClearScope?: () => void;
	/** The agent scope a single-pipeline view was opened from, if any. */
	parentScope?: PipelineAgentScope | null;
	/** Back to `parentScope`'s narrowed All Pipelines view. */
	onReturnToScope?: () => void;
}

export const PipelineToolbar = React.memo(function PipelineToolbar({
	theme,
	isAllPipelinesView,
	triggerDrawerOpen,
	setTriggerDrawerOpen,
	agentDrawerOpen,
	setAgentDrawerOpen,
	pipelines,
	selectedPipelineId,
	selectPipeline,
	createPipeline,
	deletePipeline,
	renamePipeline,
	changePipelineColor,
	isDirty,
	saveStatus,
	handleSave,
	handleDiscard,
	validationErrors,
	agentScopes,
	activeScope = null,
	onSelectAgentScope,
	onClearScope,
	parentScope = null,
	onReturnToScope,
}: PipelineToolbarProps) {
	return (
		<>
			{/* Toolbar */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<button
						onClick={() => !isAllPipelinesView && setTriggerDrawerOpen((v) => !v)}
						disabled={isAllPipelinesView}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: triggerDrawerOpen ? `${theme.colors.accent}20` : 'transparent',
							color: triggerDrawerOpen ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${triggerDrawerOpen ? theme.colors.accent : theme.colors.border}`,
							cursor: isAllPipelinesView ? 'not-allowed' : 'pointer',
							opacity: isAllPipelinesView ? 0.4 : 1,
							transition: 'all 0.15s',
						}}
						title={isAllPipelinesView ? 'Select a pipeline to add triggers' : undefined}
					>
						<Zap size={12} />
						Triggers
					</button>
				</div>
				<div className="flex items-center gap-2">
					{/* Breadcrumb: a pipeline opened from an agent-narrowed view
					    leads back to that view instead of to every pipeline. */}
					{parentScope && onReturnToScope && (
						<button
							data-testid="pipeline-scope-back"
							onClick={onReturnToScope}
							className="flex items-center gap-1 px-2 py-1 rounded text-xs"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
								cursor: 'pointer',
							}}
							title={`Back to ${parentScope.sessionName}'s pipelines`}
						>
							<ChevronLeft size={12} />
							<Bot size={12} />
							{parentScope.sessionName}
						</button>
					)}
					<PipelineSelector
						pipelines={pipelines}
						selectedPipelineId={selectedPipelineId}
						onSelect={selectPipeline}
						onCreatePipeline={createPipeline}
						onDeletePipeline={deletePipeline}
						onRenamePipeline={renamePipeline}
						onChangePipelineColor={changePipelineColor}
						agents={agentScopes}
						activeAgent={activeScope}
						onSelectAgent={onSelectAgentScope}
						theme={theme}
						textColor={theme.colors.textMain}
						borderColor={theme.colors.border}
					/>
					{activeScope && onClearScope && (
						<button
							data-testid="pipeline-scope-clear"
							onClick={onClearScope}
							className="flex items-center p-1 rounded"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
								cursor: 'pointer',
							}}
							title="Show all pipelines"
							aria-label="Show all pipelines"
						>
							<X size={12} />
						</button>
					)}
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={() => !isAllPipelinesView && setAgentDrawerOpen((v) => !v)}
						disabled={isAllPipelinesView}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: agentDrawerOpen ? `${theme.colors.accent}20` : 'transparent',
							color: agentDrawerOpen ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${agentDrawerOpen ? theme.colors.accent : theme.colors.border}`,
							cursor: isAllPipelinesView ? 'not-allowed' : 'pointer',
							opacity: isAllPipelinesView ? 0.4 : 1,
							transition: 'all 0.15s',
						}}
						title={isAllPipelinesView ? 'Select a pipeline to add agents' : undefined}
					>
						<Bot size={12} />
						Agents
					</button>

					{/* Discard Changes */}
					{isDirty && (
						<button
							onClick={handleDiscard}
							className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
							style={{
								backgroundColor: 'transparent',
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
								cursor: 'pointer',
								transition: 'all 0.15s',
							}}
							title="Discard changes and reload from YAML"
						>
							<RotateCcw size={12} />
							Discard
						</button>
					)}

					{/* Save */}
					<button
						onClick={handleSave}
						disabled={saveStatus === 'saving'}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor:
								saveStatus === 'success'
									? `${theme.colors.success}20`
									: saveStatus === 'error'
										? `${theme.colors.error}20`
										: isDirty
											? `${theme.colors.accent}20`
											: 'transparent',
							color:
								saveStatus === 'success'
									? theme.colors.success
									: saveStatus === 'error'
										? theme.colors.error
										: isDirty
											? theme.colors.accent
											: theme.colors.textDim,
							border: `1px solid ${
								saveStatus === 'success'
									? theme.colors.success
									: saveStatus === 'error'
										? theme.colors.error
										: isDirty
											? theme.colors.accent
											: theme.colors.border
							}`,
							cursor: saveStatus === 'saving' ? 'wait' : 'pointer',
							transition: 'all 0.15s',
							position: 'relative',
						}}
						title={isDirty ? 'Save pipeline to YAML' : 'No unsaved changes'}
					>
						{saveStatus === 'success' ? (
							<Check size={12} />
						) : saveStatus === 'error' ? (
							<AlertTriangle size={12} />
						) : (
							<Save size={12} />
						)}
						{saveStatus === 'saving'
							? 'Saving...'
							: saveStatus === 'success'
								? 'Saved'
								: saveStatus === 'error'
									? 'Error'
									: 'Save'}
						{isDirty && saveStatus === 'idle' && (
							<span
								data-testid="dirty-indicator"
								style={{
									width: 6,
									height: 6,
									borderRadius: '50%',
									backgroundColor: theme.colors.accent,
									position: 'absolute',
									top: 2,
									right: 2,
								}}
							/>
						)}
					</button>
				</div>
			</div>

			{/* Validation errors */}
			{validationErrors.length > 0 && (
				<div
					className="px-4 py-2 text-xs flex items-center gap-2 flex-wrap"
					style={{
						backgroundColor: `${theme.colors.error}15`,
						borderBottom: `1px solid ${theme.colors.error}`,
					}}
				>
					<AlertTriangle size={12} style={{ color: theme.colors.error, flexShrink: 0 }} />
					{validationErrors.map((err, i) => (
						<span key={i} style={{ color: theme.colors.error }}>
							{err}
							{i < validationErrors.length - 1 ? ';' : ''}
						</span>
					))}
				</div>
			)}
		</>
	);
});
