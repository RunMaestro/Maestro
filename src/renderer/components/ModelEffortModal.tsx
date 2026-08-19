/**
 * ModelEffortModal - keyboard-only tuning of an AI tab's model and reasoning
 * effort.
 *
 * The composer pills already expose both knobs, but each takes a click, a read
 * of a dropdown, and another click. This modal collapses that into one gesture:
 * Up/Down walks the model list, Left/Right walks the effort scale, Enter
 * commits both at once, Escape leaves the tab untouched. Nothing is written
 * until Enter, so a wander through the list costs nothing.
 *
 * Both axes are live at the same time - there is no focus to move between them,
 * which is what makes this fast. That is also why the model list is vertical and
 * the effort scale horizontal: the direction you press matches the axis you see.
 *
 * Options and the tab > session > agent-default ladder come from the same hook
 * and resolver the composer pills use, so the two surfaces can't disagree about
 * what this agent offers or what the tab is currently running. Effort is
 * agent-scoped rather than model-scoped, which matches the underlying CLIs: a
 * model that ignores reasoning effort simply drops the flag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, Sparkles } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui';
import {
	useAgentModelEffortOptions,
	resolveModelEffort,
} from '../hooks/agent/useAgentModelEffortOptions';
import { groupModelsByFamily } from '../utils/modelFamily';
import { readableTextOn } from '../../shared/colorContrast';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { getTabDisplayName } from '../utils/tabHelpers';
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { useTabStore } from '../stores/tabStore';

export interface ModelEffortModalProps {
	theme: Theme;
	/** The AI tab being retuned. Belongs to the active agent. */
	tabId: string;
	onClose: () => void;
}

/** Label for the empty-string option, which means "inherit the agent default". */
const DEFAULT_LABEL = '(default)';

export function ModelEffortModal({ theme, tabId, onClose }: ModelEffortModalProps) {
	const activeSession = useSessionStore(selectActiveSession);
	const tab = activeSession?.aiTabs.find((t) => t.id === tabId);
	const agentId = activeSession?.toolType;

	const { models, efforts, defaultModel, defaultEffort, loaded } =
		useAgentModelEffortOptions(agentId);
	const { model: currentModel, effort: currentEffort } = resolveModelEffort(tab, activeSession, {
		defaultModel,
		defaultEffort,
	});

	// '' (inherit the agent default) is always offered as the first choice, the
	// same way the composer pills offer it.
	const modelOptions = useMemo(() => (models.includes('') ? models : ['', ...models]), [models]);
	const effortOptions = useMemo(() => {
		if (efforts.length === 0) return [];
		return efforts.includes('') ? efforts : ['', ...efforts];
	}, [efforts]);

	// State holds only what the USER picked; until they move, the selection IS
	// the tab's current value. Seeding an index from an effect instead would
	// leave a window right after open where the highlight sits on '(default)'
	// because the option lists hadn't landed yet - and an Enter inside that
	// window would clear the override the user came here to nudge.
	const [pickedModel, setPickedModel] = useState<string | null>(null);
	const [pickedEffort, setPickedEffort] = useState<string | null>(null);

	const selectedModel = pickedModel ?? currentModel;
	const selectedEffort = pickedEffort ?? currentEffort;

	// Where the selection sits in each list. -1 (a value the agent no longer
	// offers, or a list that hasn't loaded) falls back to the first row so the
	// highlight is always somewhere visible.
	const modelIndex = Math.max(0, modelOptions.indexOf(selectedModel));
	const effortIndex = Math.max(0, effortOptions.indexOf(selectedEffort));

	const containerRef = useRef<HTMLDivElement>(null);
	const selectedRowRef = useRef<HTMLButtonElement>(null);

	// Keep the highlighted model visible while arrowing through a long catalog.
	useEffect(() => {
		selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
	}, [modelIndex]);

	const handleConfirm = useCallback(() => {
		const { setTabModel, setTabEffort } = useTabStore.getState();
		setTabModel(tabId, selectedModel || undefined);
		if (effortOptions.length > 0) {
			setTabEffort(tabId, selectedEffort || undefined);
		}
		onClose();
	}, [tabId, selectedModel, selectedEffort, effortOptions.length, onClose]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Arrows wrap at both ends: on a short effort scale, running off the end
			// and coming back around is faster than reversing direction.
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				if (modelOptions.length === 0) return;
				e.preventDefault();
				const delta = e.key === 'ArrowDown' ? 1 : -1;
				setPickedModel(
					modelOptions[(modelIndex + delta + modelOptions.length) % modelOptions.length]
				);
			} else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
				if (effortOptions.length === 0) return;
				e.preventDefault();
				const delta = e.key === 'ArrowRight' ? 1 : -1;
				setPickedEffort(
					effortOptions[(effortIndex + delta + effortOptions.length) % effortOptions.length]
				);
			} else if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				handleConfirm();
			}
		},
		[modelOptions, effortOptions, modelIndex, effortIndex, handleConfirm]
	);

	// The '(default)' row is rendered on its own above the groups, so only the
	// real model ids get grouped by vendor.
	const modelGroups = useMemo(() => groupModelsByFamily(modelOptions.slice(1)), [modelOptions]);

	const effortFillText = readableTextOn(theme.colors.bgMain, [theme.colors.warning]);
	const hasModels = modelOptions.length > 1;
	const hasEfforts = effortOptions.length > 0;
	// An empty list before the lookups settle is "not here yet", not "not
	// offered" - claiming the latter early would flash a wrong answer.
	const hasNothingToTune = loaded && !hasModels && !hasEfforts;

	const renderModelRow = (model: string) => {
		const index = modelOptions.indexOf(model);
		const isSelected = index === modelIndex;
		const isCurrent = model === currentModel;
		return (
			<button
				key={model || '__default__'}
				ref={isSelected ? selectedRowRef : undefined}
				type="button"
				onClick={() => setPickedModel(model)}
				onDoubleClick={handleConfirm}
				className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded text-xs font-mono transition-colors"
				style={{
					backgroundColor: isSelected ? theme.colors.accent : 'transparent',
					color: isSelected ? theme.colors.accentForeground : theme.colors.textMain,
				}}
			>
				<span className="flex-1 truncate">{model || DEFAULT_LABEL}</span>
				{isCurrent && (
					<span
						className="text-[9px] uppercase tracking-wide flex-shrink-0"
						style={{ color: isSelected ? theme.colors.accentForeground : theme.colors.textDim }}
					>
						current
					</span>
				)}
			</button>
		);
	};

	return (
		<Modal
			theme={theme}
			title="Change Tabs Model and Effort"
			headerIcon={<Sparkles className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.MODEL_EFFORT}
			onClose={onClose}
			initialFocusRef={containerRef}
			width={520}
			portal
			testId="model-effort-modal"
			footer={
				<div className="flex items-center justify-between gap-4 w-full">
					<div
						className="text-[11px] flex items-center gap-3"
						style={{ color: theme.colors.textDim }}
					>
						<span>&uarr;&darr; model</span>
						<span>&larr;&rarr; effort</span>
						<span>&crarr; apply</span>
						<span>esc cancel</span>
					</div>
					<div className="flex items-center gap-2">
						<ModalFooter
							theme={theme}
							onCancel={onClose}
							onConfirm={handleConfirm}
							confirmLabel="Apply"
							confirmDisabled={hasNothingToTune}
						/>
					</div>
				</div>
			}
		>
			<div
				ref={containerRef}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				className="flex flex-col gap-4 outline-none select-none"
			>
				{/* What's being retuned */}
				<div
					className="flex items-center gap-2 text-xs min-w-0"
					style={{ color: theme.colors.textDim }}
				>
					<span className="truncate">
						{tab ? getTabDisplayName(tab, activeSession?.agentSessionId) : 'Tab'}
					</span>
					{agentId && (
						<span className="flex-shrink-0 opacity-70">
							&middot; {getAgentDisplayName(agentId)}
						</span>
					)}
				</div>

				{hasNothingToTune ? (
					<div className="text-xs py-6 text-center" style={{ color: theme.colors.textDim }}>
						This agent exposes no model or effort options.
					</div>
				) : !loaded && !hasModels && !hasEfforts ? (
					<div className="text-xs py-6 text-center" style={{ color: theme.colors.textDim }}>
						Loading options...
					</div>
				) : (
					<>
						{/* Model - vertical axis */}
						{hasModels && (
							<div>
								<div className="flex items-center gap-1.5 mb-1.5">
									<Sparkles className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span
										className="text-[11px] uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Model
									</span>
								</div>
								<div
									className="max-h-56 overflow-y-auto scrollbar-thin rounded p-1"
									style={{ border: `1px solid ${theme.colors.border}` }}
								>
									{renderModelRow('')}
									{modelGroups.map((group) => (
										<div key={group.family ?? '__all__'}>
											{group.family && (
												<div
													className="px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-widest"
													style={{ color: theme.colors.textDim }}
												>
													{group.family}
												</div>
											)}
											{group.models.map(renderModelRow)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* Effort - horizontal axis */}
						{hasEfforts && (
							<div>
								<div className="flex items-center gap-1.5 mb-1.5">
									<Gauge className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />
									<span
										className="text-[11px] uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Effort
									</span>
								</div>
								<div className="flex items-center gap-1.5 flex-wrap">
									{effortOptions.map((effort, index) => {
										const isSelected = index === effortIndex;
										return (
											<button
												key={effort || '__default__'}
												type="button"
												onClick={() => setPickedEffort(effort)}
												onDoubleClick={handleConfirm}
												className="px-2.5 py-1 rounded-full text-xs transition-colors"
												style={{
													backgroundColor: isSelected
														? theme.colors.warning
														: `${theme.colors.warning}10`,
													color: isSelected ? effortFillText : theme.colors.textMain,
													border: `1px solid ${
														isSelected ? theme.colors.warning : `${theme.colors.warning}25`
													}`,
												}}
											>
												{effort || DEFAULT_LABEL}
											</button>
										);
									})}
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
