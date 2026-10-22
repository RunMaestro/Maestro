/**
 * PipelineSelector - the graph's one "what am I looking at?" picker.
 *
 * A filterable dropdown with three kinds of answer: All Pipelines, one
 * pipeline (with rename / recolor / delete), or one agent - which narrows All
 * Pipelines to every pipeline that agent belongs to. One control with one
 * search box rather than a dropdown per kind: the user types a name and sees
 * the pipeline AND the agent it matches, and the trigger always says which of
 * the three is current.
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { ChevronDown, Plus, X, Check, Layers, Pencil, Bot } from 'lucide-react';
import type { Theme } from '../../types';
import type { CuePipeline } from '../../../shared/cue-pipeline-types';
import { useClickOutside } from '../../hooks/ui/useClickOutside';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { ModalResizeGrip } from '../ui/ModalResizeGrip';
import { FilterInput } from '../ui/FilterInput';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { widestLabelWidth } from '../../utils/labelWidth';
import { highlightMatches } from '../../utils/highlightMatches';
import { PIPELINE_COLORS } from './pipelineColors';
import type { PipelineAgentScope } from './utils/pipelineMembership';

const ALL_PIPELINES_LABEL = 'All Pipelines';
/** Stable default, so the memos keyed on `agents` do not rebuild every render. */
const NO_AGENTS: PipelineAgentScope[] = [];

/** A `px-3 py-2 text-xs` row: 16px line box plus 8px of padding either side. */
const MENU_ROW_HEIGHT = 32;
const MENU_DIVIDER_HEIGHT = 1;
/** The filter box row: a `py-1` input plus the row's own `p-2` padding. */
const MENU_FILTER_HEIGHT = 44;
/** A "Pipelines" / "Agents" section label. */
const MENU_SECTION_HEIGHT = 24;
/** Pipelines visible without scrolling, on top of the All Pipelines row. */
const MENU_DEFAULT_VISIBLE_PIPELINES = 10;
/** Everything in a row that is not the name: padding, color dot, check, pencil, delete, gaps. */
const MENU_ROW_CHROME_WIDTH = 112;
/** Never open narrower than this, however short the names are. */
const MENU_DEFAULT_MIN_WIDTH = 220;
/** Never open wider than this, however long one name is; the user can still drag past it. */
const MENU_DEFAULT_MAX_WIDTH = 460;
/** Small enough to be a compact picker, large enough to still show a row and the footer. */
const MENU_MIN_SIZE = { width: 180, height: 140 };

/**
 * The menu opens wide enough to read the longest pipeline or agent name without
 * truncation, and tall enough for ten rows plus the filter box, the All
 * Pipelines row and the New Pipeline footer. A dropdown that clips the names it
 * exists to let you pick between defeats itself, and the old fixed 220 x 320
 * did both.
 */
export function pipelineMenuDefaultSize(
	pipelineNames: string[],
	agentNames: string[] = []
): {
	width: number;
	height: number;
} {
	const width = widestLabelWidth([ALL_PIPELINES_LABEL, ...pipelineNames, ...agentNames], {
		fontSizePx: 12,
		chromePx: MENU_ROW_CHROME_WIDTH,
		minPx: MENU_DEFAULT_MIN_WIDTH,
		maxPx: MENU_DEFAULT_MAX_WIDTH,
	});
	const rows = MENU_DEFAULT_VISIBLE_PIPELINES + 1; // + the All Pipelines row
	const height =
		MENU_FILTER_HEIGHT + // filter box
		rows * MENU_ROW_HEIGHT + // scrolling list
		(agentNames.length > 0 ? 2 * MENU_SECTION_HEIGHT : 0) + // Pipelines / Agents labels
		MENU_DIVIDER_HEIGHT + // rule under All Pipelines
		MENU_DIVIDER_HEIGHT + // rule above the footer
		MENU_ROW_HEIGHT; // New Pipeline footer
	return { width, height };
}

export interface PipelineSelectorProps {
	pipelines: CuePipeline[];
	selectedPipelineId: string | null;
	onSelect: (id: string | null) => void;
	onCreatePipeline: () => void;
	onDeletePipeline: (id: string) => void;
	onRenamePipeline: (id: string, name: string) => void;
	onChangePipelineColor?: (id: string, color: string) => void;
	/** Agents the view can be narrowed to. The Agents section is hidden when
	 *  this is empty or `onSelectAgent` is absent. */
	agents?: PipelineAgentScope[];
	/** The scope All Pipelines is currently narrowed to, if any. Passed whole
	 *  rather than looked up in `agents` by id, so the trigger names and counts
	 *  exactly what the canvas draws even when the two lists disagree. */
	activeAgent?: PipelineAgentScope | null;
	onSelectAgent?: (agent: PipelineAgentScope) => void;
	theme?: Theme;
	textColor?: string;
	borderColor?: string;
}

export function PipelineSelector({
	pipelines,
	selectedPipelineId,
	onSelect,
	onCreatePipeline,
	onDeletePipeline,
	onRenamePipeline,
	onChangePipelineColor,
	agents = NO_AGENTS,
	activeAgent: activeAgentScope = null,
	onSelectAgent,
	theme,
	textColor,
	borderColor,
}: PipelineSelectorProps) {
	const resolvedTextColor = textColor ?? theme?.colors.textMain ?? 'rgba(255,255,255,0.9)';
	const resolvedBorderColor = borderColor ?? theme?.colors.border ?? 'rgba(255,255,255,0.12)';
	const [isOpen, setIsOpen] = useState(false);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [colorPickerId, setColorPickerId] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const closeMenu = useCallback(() => {
		setIsOpen(false);
		setQuery('');
		setRenamingId(null);
		setColorPickerId(null);
	}, []);

	useClickOutside(
		[dropdownRef as React.RefObject<HTMLElement>, buttonRef as React.RefObject<HTMLElement>],
		closeMenu,
		isOpen
	);

	// While open the menu owns Escape: the first press clears the filter, the
	// next closes the menu. The layer stack handles Escape at capture on
	// `window`, so without a layer that outranks CUE_MODAL the key would close
	// the whole Cue modal out from under an open dropdown. A rename in progress
	// keeps its own Escape (cancel the rename) via the input's key handler.
	const handleMenuEscape = useCallback(() => {
		if (renamingId) {
			setRenamingId(null);
			return;
		}
		if (query) {
			setQuery('');
			return;
		}
		closeMenu();
	}, [renamingId, query, closeMenu]);

	const showAgents = !!onSelectAgent && agents.length > 0;

	// Recomputed only when a name actually changes: the hook re-clamps the live
	// size on viewport resize, and a default that moves under it fights that.
	const defaultSize = useMemo(
		() =>
			pipelineMenuDefaultSize(
				pipelines.map((p) => p.name),
				showAgents ? agents.map((a) => a.sessionName) : []
			),
		[pipelines, agents, showAgents]
	);

	// A pipeline list can run long or short, so the menu is the user's to size.
	// It hangs off the trigger's top-left corner, hence the 'top-left' anchor and
	// the corner-only grip.
	const menuResize = useResizableModal({
		resizeKey: 'cue-pipeline-selector',
		defaultSize,
		minSize: MENU_MIN_SIZE,
		anchor: 'top-left',
		externalRef: dropdownRef as React.RefObject<HTMLDivElement>,
	});

	const selectedPipeline = selectedPipelineId
		? pipelines.find((p) => p.id === selectedPipelineId)
		: null;
	const activeAgent = selectedPipelineId === null ? activeAgentScope : null;

	const sortedPipelines = useMemo(
		() => [...pipelines].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name)),
		[pipelines]
	);

	// Case-insensitive substring match - the same rule `highlightMatches` marks,
	// so every row the filter keeps shows why it was kept.
	const needle = query.trim().toLowerCase();
	const visiblePipelines = useMemo(
		() =>
			needle
				? sortedPipelines.filter((p) => p.name.toLowerCase().includes(needle))
				: sortedPipelines,
		[sortedPipelines, needle]
	);
	const visibleAgents = useMemo(
		() =>
			!showAgents
				? []
				: needle
					? agents.filter((a) => a.sessionName.toLowerCase().includes(needle))
					: agents,
		[agents, showAgents, needle]
	);
	const highlight = (text: string) =>
		highlightMatches(text, query.trim(), theme?.colors.accent ?? '#8b5cf6');

	const handleToggle = useCallback(() => {
		if (isOpen) closeMenu();
		else setIsOpen(true);
	}, [isOpen, closeMenu]);

	const handleSelect = useCallback(
		(id: string | null) => {
			onSelect(id);
			closeMenu();
		},
		[onSelect, closeMenu]
	);

	const handleSelectAgent = useCallback(
		(agent: PipelineAgentScope) => {
			onSelectAgent?.(agent);
			closeMenu();
		},
		[onSelectAgent, closeMenu]
	);

	// Enter takes the first match, pipelines before agents (the order drawn).
	const handleFilterKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			if (visiblePipelines.length > 0) handleSelect(visiblePipelines[0].id);
			else if (visibleAgents.length > 0) handleSelectAgent(visibleAgents[0]);
		},
		[visiblePipelines, visibleAgents, handleSelect, handleSelectAgent]
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
		closeMenu();
	}, [onCreatePipeline, closeMenu]);

	const sectionLabel = (label: string) => (
		<div
			className="px-3 text-2xs font-semibold uppercase tracking-wider flex items-end"
			style={{
				height: MENU_SECTION_HEIGHT,
				paddingBottom: 4,
				color: theme?.colors.textDim ?? 'rgba(255,255,255,0.5)',
			}}
		>
			{label}
		</div>
	);

	return (
		<div className="relative" style={{ zIndex: 20 }}>
			{/* Trigger button */}
			<button
				ref={buttonRef}
				onClick={handleToggle}
				className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium"
				style={{
					backgroundColor: theme?.colors.bgActivity ?? 'rgba(255,255,255,0.05)',
					border: `1px solid ${resolvedBorderColor}`,
					color: resolvedTextColor,
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
				) : activeAgent ? (
					<Bot size={12} style={{ color: theme?.colors.accent, flexShrink: 0 }} />
				) : (
					<MultiColorIcon />
				)}
				<span>
					{selectedPipeline
						? selectedPipeline.name
						: activeAgent
							? activeAgent.sessionName
							: ALL_PIPELINES_LABEL}
				</span>
				{activeAgent && (
					<span style={{ opacity: 0.6 }}>
						· {activeAgent.pipelineIds.length} pipeline
						{activeAgent.pipelineIds.length === 1 ? '' : 's'}
					</span>
				)}
				<ChevronDown size={10} style={{ opacity: 0.5 }} />
			</button>

			{/* Dropdown menu */}
			{isOpen && <MenuEscapeLayer onEscape={handleMenuEscape} />}
			{isOpen && (
				<div
					ref={dropdownRef}
					data-testid="pipeline-selector-menu"
					className="absolute top-full left-0 mt-1 rounded-md shadow-lg flex flex-col overflow-hidden"
					style={{
						backgroundColor: theme?.colors.bgSidebar ?? '#1e1e2e',
						border: `1px solid ${theme?.colors.border ?? 'rgba(255,255,255,0.12)'}`,
						...menuResize.style,
					}}
				>
					{theme && (
						<div className="p-2 shrink-0">
							<FilterInput
								theme={theme}
								value={query}
								onChange={setQuery}
								placeholder={showAgents ? 'Filter pipelines and agents...' : 'Filter pipelines...'}
								width="100%"
								autoFocus
								onKeyDown={handleFilterKeyDown}
							/>
						</div>
					)}

					{/* Scrollable list; the New Pipeline footer below stays pinned. */}
					<div className="flex-1 min-h-0 overflow-y-auto">
						{/* All Pipelines option */}
						<button
							onClick={() => handleSelect(null)}
							className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left"
							style={{
								color: theme?.colors.textMain ?? 'rgba(255,255,255,0.9)',
								backgroundColor: 'transparent',
								border: 'none',
								cursor: 'pointer',
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor =
									theme?.colors.bgActivity ?? 'rgba(255,255,255,0.06)';
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = 'transparent';
							}}
						>
							<MultiColorIcon />
							<span className="flex-1">{ALL_PIPELINES_LABEL}</span>
							{selectedPipelineId === null && !activeAgent && (
								<Check
									size={12}
									style={{ color: theme?.colors.textDim ?? 'rgba(255,255,255,0.5)' }}
								/>
							)}
						</button>

						{/* Divider */}
						{pipelines.length > 0 && (
							<div
								style={{
									height: 1,
									backgroundColor: theme?.colors.border ?? 'rgba(255,255,255,0.08)',
								}}
							/>
						)}

						{showAgents && visiblePipelines.length > 0 && sectionLabel('Pipelines')}

						{/* Pipeline list */}
						{visiblePipelines.map((pipeline) => (
							<div key={pipeline.id}>
								<div
									className="flex items-center gap-2 w-full px-3 py-2 text-xs"
									style={{
										color: theme?.colors.textMain ?? 'rgba(255,255,255,0.9)',
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
										e.currentTarget.style.backgroundColor =
											theme?.colors.bgActivity ?? 'rgba(255,255,255,0.06)';
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.backgroundColor = 'transparent';
									}}
								>
									<span
										style={{
											width: 10,
											height: 10,
											borderRadius: '50%',
											backgroundColor: pipeline.color,
											flexShrink: 0,
											cursor: onChangePipelineColor ? 'pointer' : 'default',
											border:
												colorPickerId === pipeline.id
													? `2px solid ${theme?.colors.textMain ?? 'rgba(255,255,255,0.8)'}`
													: '2px solid transparent',
											transition: 'border-color 0.15s',
										}}
										onClick={(e) => {
											e.stopPropagation();
											if (onChangePipelineColor) {
												setColorPickerId((prev) => (prev === pipeline.id ? null : pipeline.id));
											}
										}}
										title="Change color"
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
												backgroundColor: theme?.colors.bgActivity ?? 'rgba(255,255,255,0.1)',
												border: `1px solid ${theme?.colors.border ?? 'rgba(255,255,255,0.2)'}`,
												color: theme?.colors.textMain ?? 'rgba(255,255,255,0.9)',
												outline: 'none',
											}}
										/>
									) : (
										<span className="flex-1 truncate">{highlight(pipeline.name)}</span>
									)}
									{selectedPipelineId === pipeline.id && renamingId !== pipeline.id && (
										<Check
											size={12}
											style={{ color: theme?.colors.textDim ?? 'rgba(255,255,255,0.5)' }}
										/>
									)}
									{renamingId !== pipeline.id && (
										<button
											onClick={(e) => {
												e.stopPropagation();
												handleStartRename(pipeline);
											}}
											className="flex items-center justify-center rounded"
											style={{
												width: 16,
												height: 16,
												backgroundColor: 'transparent',
												border: 'none',
												color: theme?.colors.textDim ?? 'rgba(255,255,255,0.3)',
												cursor: 'pointer',
												flexShrink: 0,
												transition: 'color 0.15s',
											}}
											onMouseEnter={(e) => {
												e.currentTarget.style.color =
													theme?.colors.textMain ?? 'rgba(255,255,255,0.8)';
											}}
											onMouseLeave={(e) => {
												e.currentTarget.style.color =
													theme?.colors.textDim ?? 'rgba(255,255,255,0.3)';
											}}
											title="Rename pipeline"
										>
											<Pencil size={10} />
										</button>
									)}
									<button
										onClick={(e) => handleDelete(e, pipeline.id)}
										className="flex items-center justify-center rounded"
										style={{
											width: 16,
											height: 16,
											backgroundColor: 'transparent',
											border: 'none',
											color: theme?.colors.textDim ?? 'rgba(255,255,255,0.3)',
											cursor: 'pointer',
											flexShrink: 0,
											transition: 'color 0.15s',
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.color = theme?.colors.error ?? '#ef4444';
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.color =
												theme?.colors.textDim ?? 'rgba(255,255,255,0.3)';
										}}
									>
										<X size={10} />
									</button>
								</div>
								{/* Color picker palette */}
								{colorPickerId === pipeline.id && onChangePipelineColor && (
									<div
										onClick={(e) => e.stopPropagation()}
										style={{
											display: 'grid',
											gridTemplateColumns: 'repeat(6, 1fr)',
											gap: 4,
											padding: '8px 10px',
											backgroundColor: theme?.colors.bgMain ?? '#16162a',
											borderTop: `1px solid ${theme?.colors.border ?? 'rgba(255,255,255,0.08)'}`,
											zIndex: 10,
										}}
									>
										{PIPELINE_COLORS.map((c) => (
											<button
												key={c}
												onClick={() => {
													onChangePipelineColor(pipeline.id, c);
													setColorPickerId(null);
												}}
												style={{
													width: 20,
													height: 20,
													borderRadius: '50%',
													backgroundColor: c,
													border:
														c === pipeline.color
															? `2px solid ${theme?.colors.textMain ?? 'rgba(255,255,255,0.9)'}`
															: '2px solid transparent',
													cursor: 'pointer',
													transition: 'transform 0.1s, border-color 0.15s',
													padding: 0,
												}}
												onMouseEnter={(e) => {
													e.currentTarget.style.transform = 'scale(1.2)';
												}}
												onMouseLeave={(e) => {
													e.currentTarget.style.transform = 'scale(1)';
												}}
												title={c}
											/>
										))}
									</div>
								)}
							</div>
						))}

						{visibleAgents.length > 0 && (
							<>
								{sectionLabel('Agents')}
								{visibleAgents.map((agent) => (
									<button
										key={agent.sessionId}
										data-testid={`pipeline-selector-agent-${agent.sessionId}`}
										onClick={() => handleSelectAgent(agent)}
										className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left"
										style={{
											color: theme?.colors.textMain ?? 'rgba(255,255,255,0.9)',
											backgroundColor: 'transparent',
											border: 'none',
											cursor: 'pointer',
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.backgroundColor =
												theme?.colors.bgActivity ?? 'rgba(255,255,255,0.06)';
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.backgroundColor = 'transparent';
										}}
									>
										<Bot
											size={12}
											style={{
												color: theme?.colors.textDim ?? 'rgba(255,255,255,0.5)',
												flexShrink: 0,
											}}
										/>
										<span className="flex-1 truncate">{highlight(agent.sessionName)}</span>
										<span style={{ color: theme?.colors.textDim ?? 'rgba(255,255,255,0.5)' }}>
											{agent.pipelineIds.length}
										</span>
										{activeAgent?.sessionId === agent.sessionId && (
											<Check
												size={12}
												style={{ color: theme?.colors.textDim ?? 'rgba(255,255,255,0.5)' }}
											/>
										)}
									</button>
								))}
							</>
						)}

						{needle && visiblePipelines.length === 0 && visibleAgents.length === 0 && (
							<div
								className="px-3 py-2 text-xs"
								style={{ color: theme?.colors.textDim ?? 'rgba(255,255,255,0.5)' }}
							>
								No pipelines or agents match "{query.trim()}"
							</div>
						)}
					</div>

					{/* Divider */}
					<div
						style={{
							height: 1,
							flexShrink: 0,
							backgroundColor: theme?.colors.border ?? 'rgba(255,255,255,0.08)',
						}}
					/>

					{/* New Pipeline button */}
					<button
						onClick={handleCreate}
						className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left"
						style={{
							flexShrink: 0,
							color: theme?.colors.textDim ?? 'rgba(255,255,255,0.6)',
							backgroundColor: 'transparent',
							border: 'none',
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor =
								theme?.colors.bgActivity ?? 'rgba(255,255,255,0.06)';
							e.currentTarget.style.color = theme?.colors.textMain ?? 'rgba(255,255,255,0.9)';
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = 'transparent';
							e.currentTarget.style.color = theme?.colors.textDim ?? 'rgba(255,255,255,0.6)';
						}}
					>
						<Plus size={12} />
						<span>New Pipeline</span>
					</button>

					<ModalResizeGrip
						theme={theme}
						label="Resize pipeline menu"
						onResizeStart={(e) => menuResize.onResizeStart('se', e)}
						onReset={menuResize.onResetSize}
						canReset={menuResize.canReset}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * Registers the open menu with the layer stack. A component of its own, mounted
 * only while the menu is open, so a closed selector (the toolbar's resting
 * state) never touches the layer stack at all.
 */
function MenuEscapeLayer({ onEscape }: { onEscape: () => void }) {
	useModalLayer(MODAL_PRIORITIES.CUE_PIPELINE_SELECTOR, undefined, onEscape, {
		focusTrap: 'none',
		blocksLowerLayers: false,
		capturesFocus: false,
	});
	return null;
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
