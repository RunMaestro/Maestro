import { GripVertical, Plus, RotateCcw, X } from 'lucide-react';
import type React from 'react';
import type { BatchDocumentEntry, Theme } from '../../../types';
import { formatMetaKey } from '../../../utils/shortcutFormatter';
import { canDisableReset } from '../utils/documentCounts';
import { TaskCountBadge } from './TaskCountBadge';

interface DocumentRowProps {
	theme: Theme;
	doc: BatchDocumentEntry;
	index: number;
	documents: BatchDocumentEntry[];
	taskCount: number;
	loadingTaskCounts: boolean;
	draggedId: string | null;
	dropTargetIndex: number | null;
	isCopyDrag: boolean;
	onDragStart: (e: React.DragEvent, id: string) => void;
	onDrag: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent, id: string, index: number) => void;
	onDrop: (e: React.DragEvent) => void;
	onDragEnd: () => void;
	onRemove: (id: string) => void;
	onToggleReset: (id: string) => void;
	onDuplicate: (id: string) => void;
}

function DropIndicator({
	theme,
	isCopyDrag,
	position,
}: {
	theme: Theme;
	isCopyDrag: boolean;
	position: 'top' | 'bottom';
}) {
	const color = isCopyDrag ? theme.colors.success : theme.colors.accent;
	return (
		<div
			className={`absolute left-0 right-0 ${position === 'top' ? 'top-0' : 'bottom-0'} h-0.5 z-20 pointer-events-none`}
			style={{ backgroundColor: color }}
		>
			<div
				className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full"
				style={{ backgroundColor: color }}
			/>
			<div
				className="absolute -right-1 -top-[3px] w-2 h-2 rounded-full"
				style={{ backgroundColor: color }}
			/>
		</div>
	);
}

export function DocumentRow({
	theme,
	doc,
	index,
	documents,
	taskCount,
	loadingTaskCounts,
	draggedId,
	dropTargetIndex,
	isCopyDrag,
	onDragStart,
	onDrag,
	onDragOver,
	onDrop,
	onDragEnd,
	onRemove,
	onToggleReset,
	onDuplicate,
}: DocumentRowProps) {
	const isBeingDragged = draggedId === doc.id;
	const showDropIndicatorBefore = dropTargetIndex === index && draggedId !== null;
	const showDropIndicatorAfter =
		dropTargetIndex === index + 1 && index === documents.length - 1 && draggedId !== null;
	const resetCanDisable = canDisableReset(documents, doc.filename);

	let tooltipText: string;
	if (doc.resetOnCompletion) {
		if (resetCanDisable) {
			tooltipText =
				'Reset enabled: uncompleted tasks will be re-checked when done. Click to disable.';
		} else {
			tooltipText =
				'Reset enabled: uncompleted tasks will be re-checked when done. Remove duplicates to disable.';
		}
	} else {
		tooltipText = `Enable reset, or ${formatMetaKey()}+drag to copy`;
	}

	return (
		<div
			className="relative"
			style={index > 0 ? { borderTop: `1px solid ${theme.colors.border}22` } : undefined}
		>
			{showDropIndicatorBefore && (
				<DropIndicator theme={theme} isCopyDrag={isCopyDrag} position="top" />
			)}

			<div
				draggable={!doc.isMissing}
				onDragStart={(e) => !doc.isMissing && onDragStart(e, doc.id)}
				onDrag={onDrag}
				onDragOver={(e) => onDragOver(e, doc.id, index)}
				onDrop={onDrop}
				onDragEnd={onDragEnd}
				className={`flex items-center gap-3 px-3 py-2 transition-all ${
					isBeingDragged ? 'opacity-50' : ''
				} hover:bg-white/5 ${doc.isMissing ? 'opacity-60' : ''}`}
				style={{
					backgroundColor: doc.isMissing ? theme.colors.error + '08' : undefined,
				}}
			>
				<GripVertical
					className={`w-4 h-4 shrink-0 ${doc.isMissing ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}`}
					style={{
						color: doc.isMissing ? theme.colors.error + '60' : theme.colors.textDim,
					}}
				/>

				<span
					className={`flex-1 text-sm font-medium overflow-hidden text-ellipsis whitespace-nowrap ${doc.isMissing ? 'line-through' : ''}`}
					style={{
						color: doc.isMissing ? theme.colors.error : theme.colors.textMain,
						direction: 'rtl',
						textAlign: 'left',
					}}
					title={`${doc.filename}.md`}
				>
					<bdi>{doc.filename}.md</bdi>
				</span>

				{doc.isMissing && (
					<span
						className="text-[10px] px-1.5 py-0.5 rounded shrink-0 uppercase font-bold"
						style={{
							backgroundColor: theme.colors.error + '20',
							color: theme.colors.error,
						}}
						title="This document no longer exists in the folder"
					>
						Missing
					</span>
				)}

				{!doc.isMissing ? (
					<TaskCountBadge
						theme={theme}
						count={taskCount}
						loading={loadingTaskCounts}
						zeroTone="error"
					/>
				) : (
					<span className="text-xs px-2 py-0.5 shrink-0 invisible">0 tasks</span>
				)}

				{!doc.isMissing ? (
					<button
						type="button"
						onClick={() => {
							if (!doc.resetOnCompletion || resetCanDisable) {
								onToggleReset(doc.id);
							}
						}}
						className={`p-1 rounded transition-colors shrink-0 ${
							doc.resetOnCompletion
								? resetCanDisable
									? 'hover:bg-white/10'
									: 'cursor-not-allowed'
								: 'hover:bg-white/10'
						}`}
						style={{
							backgroundColor: doc.resetOnCompletion ? theme.colors.accent + '20' : 'transparent',
							color: doc.resetOnCompletion ? theme.colors.accent : theme.colors.textDim,
							opacity: doc.resetOnCompletion && !resetCanDisable ? 0.7 : 1,
						}}
						title={tooltipText}
					>
						<RotateCcw className="w-3.5 h-3.5" />
					</button>
				) : (
					<span className="p-1 shrink-0 invisible">
						<RotateCcw className="w-3.5 h-3.5" />
					</span>
				)}

				{doc.resetOnCompletion && !doc.isMissing ? (
					<button
						type="button"
						onClick={() => onDuplicate(doc.id)}
						className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
						style={{ color: theme.colors.textDim }}
						title="Duplicate document"
					>
						<Plus className="w-3.5 h-3.5" />
					</button>
				) : (
					<span className="p-1 shrink-0 invisible">
						<Plus className="w-3.5 h-3.5" />
					</span>
				)}

				<button
					type="button"
					onClick={() => onRemove(doc.id)}
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
					style={{
						color: doc.isMissing ? theme.colors.error : theme.colors.textDim,
					}}
					title={doc.isMissing ? 'Remove missing document' : 'Remove document'}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			{showDropIndicatorAfter && (
				<DropIndicator theme={theme} isCopyDrag={isCopyDrag} position="bottom" />
			)}
		</div>
	);
}
