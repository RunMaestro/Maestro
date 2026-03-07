/**
 * PipelineSelector — Dropdown for selecting which pipeline to view/edit.
 *
 * Shows current selection with color dot, and a dropdown menu with
 * All Pipelines, individual pipelines (with rename/delete), and New Pipeline.
 */

import { useState, useRef, useCallback } from 'react';
import { ChevronDown, Plus, X, Check, Layers } from 'lucide-react';
import type { CuePipeline } from '../../../shared/cue-pipeline-types';
import { useClickOutside } from '../../hooks/ui/useClickOutside';
import { PIPELINE_COLORS } from './pipelineColors';

export interface PipelineSelectorProps {
	pipelines: CuePipeline[];
	selectedPipelineId: string | null;
	onSelect: (id: string | null) => void;
	onCreatePipeline: () => void;
	onDeletePipeline: (id: string) => void;
	onRenamePipeline: (id: string, name: string) => void;
}

export function PipelineSelector({
	pipelines,
	selectedPipelineId,
	onSelect,
	onCreatePipeline,
	onDeletePipeline,
	onRenamePipeline,
}: PipelineSelectorProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	useClickOutside(
		[dropdownRef as React.RefObject<HTMLElement>, buttonRef as React.RefObject<HTMLElement>],
		() => setIsOpen(false),
		isOpen
	);

	const selectedPipeline = selectedPipelineId
		? pipelines.find((p) => p.id === selectedPipelineId)
		: null;

	const handleToggle = useCallback(() => {
		setIsOpen((v) => !v);
		setRenamingId(null);
	}, []);

	const handleSelect = useCallback(
		(id: string | null) => {
			onSelect(id);
			setIsOpen(false);
			setRenamingId(null);
		},
		[onSelect]
	);

	const handleStartRename = useCallback((pipeline: CuePipeline) => {
		setRenamingId(pipeline.id);
		setRenameValue(pipeline.name);
	}, []);

	const handleFinishRename = useCallback(() => {
		if (renamingId && renameValue.trim()) {
			onRenamePipeline(renamingId, renameValue.trim());
		}
		setRenamingId(null);
	}, [renamingId, renameValue, onRenamePipeline]);

	const handleRenameKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter') {
				handleFinishRename();
			} else if (e.key === 'Escape') {
				setRenamingId(null);
			}
		},
		[handleFinishRename]
	);

	const handleDelete = useCallback(
		(e: React.MouseEvent, id: string) => {
			e.stopPropagation();
			onDeletePipeline(id);
		},
		[onDeletePipeline]
	);

	const handleCreate = useCallback(() => {
		onCreatePipeline();
		setIsOpen(false);
	}, [onCreatePipeline]);

	return (
		<div className="relative" style={{ zIndex: 20 }}>
			{/* Trigger button */}
			<button
				ref={buttonRef}
				onClick={handleToggle}
				className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium"
				style={{
					backgroundColor: 'rgba(255,255,255,0.05)',
					border: '1px solid rgba(255,255,255,0.12)',
					color: 'rgba(255,255,255,0.9)',
					cursor: 'pointer',
					transition: 'all 0.15s',
				}}
			>
				{selectedPipeline ? (
					<span
						style={{
							width: 8,
							height: 8,
							borderRadius: '50%',
							backgroundColor: selectedPipeline.color,
							flexShrink: 0,
						}}
					/>
				) : (
					<MultiColorIcon />
				)}
				<span>{selectedPipeline ? selectedPipeline.name : 'All Pipelines'}</span>
				<ChevronDown size={10} style={{ opacity: 0.5 }} />
			</button>

			{/* Dropdown menu */}
			{isOpen && (
				<div
					ref={dropdownRef}
					className="absolute top-full left-0 mt-1 rounded-md shadow-lg overflow-hidden"
					style={{
						backgroundColor: '#1e1e2e',
						border: '1px solid rgba(255,255,255,0.12)',
						minWidth: 200,
						maxHeight: 320,
						overflowY: 'auto',
					}}
				>
					{/* All Pipelines option */}
					<button
						onClick={() => handleSelect(null)}
						className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left"
						style={{
							color: 'rgba(255,255,255,0.9)',
							backgroundColor: 'transparent',
							border: 'none',
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)';
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = 'transparent';
						}}
					>
						<MultiColorIcon />
						<span className="flex-1">All Pipelines</span>
						{selectedPipelineId === null && (
							<Check size={12} style={{ color: 'rgba(255,255,255,0.5)' }} />
						)}
					</button>

					{/* Divider */}
					{pipelines.length > 0 && (
						<div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />
					)}

					{/* Pipeline list */}
					{pipelines.map((pipeline) => (
						<div
							key={pipeline.id}
							className="flex items-center gap-2 w-full px-3 py-2 text-xs"
							style={{
								color: 'rgba(255,255,255,0.9)',
								cursor: 'pointer',
							}}
							onClick={() => {
								if (renamingId !== pipeline.id) {
									handleSelect(pipeline.id);
								}
							}}
							onDoubleClick={(e) => {
								e.stopPropagation();
								handleStartRename(pipeline);
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)';
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = 'transparent';
							}}
						>
							<span
								style={{
									width: 8,
									height: 8,
									borderRadius: '50%',
									backgroundColor: pipeline.color,
									flexShrink: 0,
								}}
							/>
							{renamingId === pipeline.id ? (
								<input
									autoFocus
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onBlur={handleFinishRename}
									onKeyDown={handleRenameKeyDown}
									onClick={(e) => e.stopPropagation()}
									className="flex-1 text-xs rounded px-1"
									style={{
										backgroundColor: 'rgba(255,255,255,0.1)',
										border: '1px solid rgba(255,255,255,0.2)',
										color: 'rgba(255,255,255,0.9)',
										outline: 'none',
									}}
								/>
							) : (
								<span className="flex-1 truncate">{pipeline.name}</span>
							)}
							{selectedPipelineId === pipeline.id && renamingId !== pipeline.id && (
								<Check size={12} style={{ color: 'rgba(255,255,255,0.5)' }} />
							)}
							<button
								onClick={(e) => handleDelete(e, pipeline.id)}
								className="flex items-center justify-center rounded"
								style={{
									width: 16,
									height: 16,
									backgroundColor: 'transparent',
									border: 'none',
									color: 'rgba(255,255,255,0.3)',
									cursor: 'pointer',
									flexShrink: 0,
									transition: 'color 0.15s',
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.color = '#ef4444';
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.color = 'rgba(255,255,255,0.3)';
								}}
							>
								<X size={10} />
							</button>
						</div>
					))}

					{/* Divider */}
					<div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />

					{/* New Pipeline button */}
					<button
						onClick={handleCreate}
						className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left"
						style={{
							color: 'rgba(255,255,255,0.6)',
							backgroundColor: 'transparent',
							border: 'none',
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)';
							e.currentTarget.style.color = 'rgba(255,255,255,0.9)';
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = 'transparent';
							e.currentTarget.style.color = 'rgba(255,255,255,0.6)';
						}}
					>
						<Plus size={12} />
						<span>New Pipeline</span>
					</button>
				</div>
			)}
		</div>
	);
}

/** Small multi-color icon representing "All Pipelines" */
function MultiColorIcon() {
	const colors = PIPELINE_COLORS.slice(0, 4);
	return (
		<Layers
			size={12}
			style={{
				color: colors[0],
				filter: 'drop-shadow(0 0 1px rgba(255,255,255,0.3))',
			}}
		/>
	);
}
