/**
 * PipelineToolbar — Toolbar with trigger/agent drawer toggles, pipeline selector,
 * settings toggle, save/discard buttons, and validation error bar.
 */

import React from 'react';
import { Zap, Bot, Save, RotateCcw, Check, AlertTriangle, Settings } from 'lucide-react';
import type { Theme } from '../../types';
import type { CuePipeline } from '../../../shared/cue-pipeline-types';
import { PipelineSelector } from './PipelineSelector';

export interface PipelineToolbarProps {
	theme: Theme;
	isAllPipelinesView: boolean;
	triggerDrawerOpen: boolean;
	setTriggerDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	agentDrawerOpen: boolean;
	setAgentDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	showSettings: boolean;
	setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
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
}

export const PipelineToolbar = React.memo(function PipelineToolbar({
	theme,
	isAllPipelinesView,
	triggerDrawerOpen,
	setTriggerDrawerOpen,
	agentDrawerOpen,
	setAgentDrawerOpen,
	showSettings,
	setShowSettings,
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
					<PipelineSelector
						pipelines={pipelines}
						selectedPipelineId={selectedPipelineId}
						onSelect={selectPipeline}
						onCreatePipeline={createPipeline}
						onDeletePipeline={deletePipeline}
						onRenamePipeline={renamePipeline}
						onChangePipelineColor={changePipelineColor}
						theme={theme}
						textColor={theme.colors.textMain}
						borderColor={theme.colors.border}
					/>
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

					{/* Settings toggle */}
					<button
						onClick={() => setShowSettings((v) => !v)}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: showSettings ? `${theme.colors.accent}20` : 'transparent',
							color: showSettings ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${showSettings ? theme.colors.accent : theme.colors.border}`,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
						title="Global Cue settings"
					>
						<Settings size={12} />
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
