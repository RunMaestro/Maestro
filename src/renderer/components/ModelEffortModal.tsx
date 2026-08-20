/**
 * ModelEffortModal - keyboard-only tuning of an AI tab's model and reasoning
 * effort, drawn as a two-axis console rather than a dialog.
 *
 * The composer pills already expose both knobs, but each takes a click, a read
 * of a dropdown, and another click. This collapses that into one gesture:
 * Up/Down walks the model wheel, Left/Right walks the effort scale, Enter
 * commits both at once, Escape leaves the tab untouched. Nothing is written
 * until Enter, so a wander through the list costs nothing.
 *
 * Both axes are live at the same time - there is no focus to move between them,
 * which is what makes this fast. Everything about the presentation serves that
 * one idea:
 *
 *   - There is no dialog chrome. A titled card with a button row would put a
 *     third thing (the focus ring) on screen and invite tabbing between panes.
 *     The composition floats on a blurred scrim instead, so the only two things
 *     with structure are the two axes.
 *   - The model list is a vertical wheel and the effort list a horizontal
 *     scale, so the direction you press matches the axis you see. Rows are
 *     positioned by transform and keyed by model id, which is what lets the
 *     wheel rotate rather than repaint: a model that stays in view animates to
 *     its new slot.
 *   - Effort is drawn as a level meter because it IS an ordered scale - bars
 *     fill up to the selection. Model is a set with no order, so it gets none.
 *   - The shortcut legend is the button row. Each hint is a real keycap that
 *     sinks when you press the matching key, and Apply / Cancel are clickable,
 *     which is what keeps a pointer-only user (remote desktop, tablet) able to
 *     leave. See UI-PATTERNS.md on graphical exits.
 *
 * Options and the tab > session > agent-default ladder come from the same hook
 * and resolver the composer pills use, so the two surfaces can't disagree about
 * what this agent offers or what the tab is currently running. Effort is
 * agent-scoped rather than model-scoped, which matches the underlying CLIs: a
 * model that ignores reasoning effort simply drops the flag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Sparkles } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { KeycapHint } from './ui';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import {
	useAgentModelEffortOptions,
	resolveModelEffort,
} from '../hooks/agent/useAgentModelEffortOptions';
import { getModelFamily } from '../utils/modelFamily';
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

/** Height of one wheel slot. Rows are positioned by multiples of this. */
const ROW_HEIGHT = 38;

/**
 * Slots shown above and below the selection, when the catalog is long enough.
 * Two, not three: the end-fade mask erases whatever sits in the outermost slot
 * of a deeper wheel, so a third ring buys 76px of dead air and nothing visible.
 */
const MAX_WHEEL_RADIUS = 2;

/**
 * How a row is drawn at each distance from the selection. Index is |offset|,
 * so the wheel reads as depth rather than as a list with one row highlighted.
 * The last entry has to survive the end-fade with something still legible -
 * this is the falloff and the mask working together, not independently.
 */
const WHEEL_DEPTH = [
	{ opacity: 1, scale: 1, fontSize: 15, fontWeight: 500 },
	{ opacity: 0.62, scale: 0.94, fontSize: 13, fontWeight: 400 },
	{ opacity: 0.32, scale: 0.88, fontSize: 12, fontWeight: 400 },
];

/** Trackpad delta to absorb before the wheel advances one row. */
const WHEEL_STEP_DELTA = 24;

/** How long a keycap stays sunk after its key fires, in ms. */
const KEY_FLASH_MS = 140;

type AxisKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape';

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
	useFocusOnMount(containerRef, 0);
	useModalLayer(MODAL_PRIORITIES.MODEL_EFFORT, 'Change model and effort', onClose);

	// Which keycap is currently sunk. Set when a key fires and released on a
	// timer, because a key that repeats never sends keyup between repeats and
	// the cap would stay stuck down while the user holds an arrow.
	const [flashedKey, setFlashedKey] = useState<AxisKey | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout>>();
	const flashKey = useCallback((key: AxisKey) => {
		setFlashedKey(key);
		clearTimeout(flashTimerRef.current);
		flashTimerRef.current = setTimeout(() => setFlashedKey(null), KEY_FLASH_MS);
	}, []);
	useEffect(() => () => clearTimeout(flashTimerRef.current), []);

	const stepModel = useCallback(
		(delta: number) => {
			if (modelOptions.length === 0) return;
			setPickedModel(
				modelOptions[(modelIndex + delta + modelOptions.length) % modelOptions.length]
			);
		},
		[modelOptions, modelIndex]
	);

	const stepEffort = useCallback(
		(delta: number) => {
			if (effortOptions.length === 0) return;
			setPickedEffort(
				effortOptions[(effortIndex + delta + effortOptions.length) % effortOptions.length]
			);
		},
		[effortOptions, effortIndex]
	);

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
				const down = e.key === 'ArrowDown';
				flashKey(down ? 'down' : 'up');
				stepModel(down ? 1 : -1);
			} else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
				if (effortOptions.length === 0) return;
				e.preventDefault();
				const right = e.key === 'ArrowRight';
				flashKey(right ? 'right' : 'left');
				stepEffort(right ? 1 : -1);
			} else if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				flashKey('enter');
				handleConfirm();
			} else if (e.key === 'Escape') {
				// The layer stack owns the actual close; this only echoes the press
				// on the cap so the legend stays honest about what fired.
				flashKey('escape');
			}
		},
		[modelOptions.length, effortOptions.length, stepModel, stepEffort, handleConfirm, flashKey]
	);

	// Trackpad scrolling over the wheel. Deltas are accumulated so a light
	// two-finger flick advances one row instead of spinning through the catalog.
	const scrollAccumulatorRef = useRef(0);
	const handleWheelScroll = useCallback(
		(e: React.WheelEvent) => {
			if (modelOptions.length === 0) return;
			scrollAccumulatorRef.current += e.deltaY;
			while (Math.abs(scrollAccumulatorRef.current) >= WHEEL_STEP_DELTA) {
				const direction = scrollAccumulatorRef.current > 0 ? 1 : -1;
				scrollAccumulatorRef.current -= direction * WHEEL_STEP_DELTA;
				stepModel(direction);
				flashKey(direction > 0 ? 'down' : 'up');
			}
		},
		[modelOptions.length, stepModel, flashKey]
	);

	// The slots currently on the wheel. The radius is capped at half the catalog
	// so a short list can wrap without the same model appearing in two slots.
	const wheelSlots = useMemo(() => {
		const count = modelOptions.length;
		if (count === 0) return [];
		const radius = Math.max(0, Math.min(MAX_WHEEL_RADIUS, Math.floor((count - 1) / 2)));
		const slots: Array<{ offset: number; model: string }> = [];
		for (let offset = -radius; offset <= radius; offset++) {
			slots.push({
				offset,
				model: modelOptions[(((modelIndex + offset) % count) + count) % count],
			});
		}
		return slots;
	}, [modelOptions, modelIndex]);

	const wheelHeight = wheelSlots.length * ROW_HEIGHT;

	// The effort scale proper. '(default)' is not a point on it - it means "let
	// the agent decide" - so it sits apart and gets no level bar.
	const effortScale = useMemo(() => effortOptions.filter((e) => e !== ''), [effortOptions]);
	const effortScaleIndex = effortScale.indexOf(selectedEffort);
	const hasDefaultEffort = effortOptions.includes('');

	const effortFillText = readableTextOn(theme.colors.bgMain, [theme.colors.warning]);
	const hasModels = modelOptions.length > 1;
	const hasEfforts = effortOptions.length > 0;
	// An empty list before the lookups settle is "not here yet", not "not
	// offered" - claiming the latter early would flash a wrong answer.
	const hasNothingToTune = loaded && !hasModels && !hasEfforts;

	// The caption under the wheel. It names the vendor for a real model id and
	// spells out what '(default)' resolves to, which the row itself can't say.
	const wheelCaption = useMemo(() => {
		if (!selectedModel) {
			return defaultModel ? `Agent default - ${defaultModel}` : 'Agent default';
		}
		// 'Other' is what the matcher returns when it recognizes nothing, so it
		// adds no information - show the current marker alone, or nothing.
		const family = getModelFamily(selectedModel);
		const vendor = family === 'Other' ? '' : family;
		if (selectedModel !== currentModel) return vendor;
		return vendor ? `${vendor} \u00b7 current` : 'current';
	}, [selectedModel, defaultModel, currentModel]);

	const renderWheelRow = ({ offset, model }: { offset: number; model: string }) => {
		const depth = WHEEL_DEPTH[Math.min(Math.abs(offset), WHEEL_DEPTH.length - 1)];
		const isSelected = offset === 0;
		const isCurrent = model === currentModel;
		return (
			<button
				key={model || '__default__'}
				type="button"
				onClick={() => setPickedModel(model)}
				onDoubleClick={handleConfirm}
				tabIndex={-1}
				aria-current={isSelected || undefined}
				className="maestro-wheel-row absolute left-0 right-0 top-1/2 flex items-center justify-center gap-2 px-6 font-mono cursor-pointer"
				style={{
					height: ROW_HEIGHT,
					// Positioning by transform (rather than by document flow) is what
					// makes this a wheel: a row that survives a step animates from its
					// old slot to its new one instead of being repainted in place.
					transform: `translateY(calc(-50% + ${offset * ROW_HEIGHT}px)) scale(${depth.scale})`,
					opacity: depth.opacity,
					color: isSelected ? theme.colors.textMain : theme.colors.textDim,
					fontSize: depth.fontSize,
					fontWeight: depth.fontWeight,
					transition:
						'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease, font-size 220ms ease, color 220ms ease',
				}}
			>
				<span className="truncate">{model || DEFAULT_LABEL}</span>
				{isCurrent && !isSelected && (
					<span
						className="w-1 h-1 rounded-full shrink-0"
						style={{ backgroundColor: theme.colors.accent }}
						aria-hidden
					/>
				)}
			</button>
		);
	};

	/**
	 * One stop on the effort axis. `scaleIndex` is its position on the scale, or
	 * undefined for '(default)', which sits off the scale and so carries no
	 * level bar.
	 */
	const renderEffortOption = (effort: string, scaleIndex?: number) => {
		const isSelected = effort === selectedEffort;
		const onScale = scaleIndex !== undefined;
		// Bars ramp with the level and fill up to the selection, so the scale can
		// be read at a glance without reading a single word.
		const barHeight = onScale ? 5 + (scaleIndex / Math.max(1, effortScale.length - 1)) * 13 : 0;
		const barFilled = onScale && effortScaleIndex >= 0 && scaleIndex <= effortScaleIndex;

		return (
			<div key={effort || '__default__'} className="flex flex-col items-stretch gap-2">
				<button
					type="button"
					onClick={() => setPickedEffort(effort)}
					onDoubleClick={handleConfirm}
					tabIndex={-1}
					aria-current={isSelected || undefined}
					className="maestro-effort-stop px-3 py-1 rounded-full text-xs cursor-pointer whitespace-nowrap"
					style={{
						backgroundColor: isSelected ? theme.colors.warning : `${theme.colors.warning}10`,
						color: isSelected ? effortFillText : theme.colors.textDim,
						border: `1px solid ${isSelected ? theme.colors.warning : `${theme.colors.warning}25`}`,
						transform: isSelected ? 'translateY(-2px)' : 'none',
						boxShadow: isSelected ? `0 0 18px ${theme.colors.warning}59` : 'none',
						transition:
							'transform 180ms cubic-bezier(0.22, 1, 0.36, 1), background-color 180ms ease, color 180ms ease, box-shadow 180ms ease',
					}}
				>
					{effort || DEFAULT_LABEL}
				</button>
				<div className="h-[18px] flex items-end justify-center" aria-hidden>
					{onScale && (
						<span
							className="w-[62%] rounded-t-[2px]"
							style={{
								height: barHeight,
								backgroundColor: barFilled ? theme.colors.warning : `${theme.colors.warning}1f`,
								transition: 'background-color 180ms ease, height 180ms ease',
							}}
						/>
					)}
				</div>
			</div>
		);
	};

	return createPortal(
		<div
			className="fixed inset-0 z-[1000] flex items-center justify-center maestro-console-scrim"
			style={{ backgroundColor: 'rgba(0, 0, 0, 0.62)' }}
			onMouseDown={onClose}
			data-testid="model-effort-modal"
		>
			<div
				ref={containerRef}
				role="dialog"
				aria-modal="true"
				aria-label="Change model and effort"
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				onMouseDown={(e) => e.stopPropagation()}
				data-testid="model-effort-surface"
				className="maestro-console-enter relative flex flex-col items-center gap-7 outline-none select-none px-10"
				style={{ width: 'min(560px, 92vw)' }}
			>
				{/* A soft wash behind the composition so it lifts off the scrim
				    without needing a card to sit in. */}
				<div
					aria-hidden
					className="absolute pointer-events-none"
					style={{
						inset: '-14% -6%',
						background: `radial-gradient(60% 46% at 50% 44%, ${theme.colors.accent}1f, transparent 70%)`,
					}}
				/>

				{/* What's being retuned */}
				<div
					className="relative flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] min-w-0"
					style={{ color: theme.colors.textDim }}
				>
					<span className="truncate">
						{tab ? getTabDisplayName(tab, activeSession?.agentSessionId) : 'Tab'}
					</span>
					{agentId && (
						<>
							<span className="opacity-40">&middot;</span>
							<span className="shrink-0 opacity-70">{getAgentDisplayName(agentId)}</span>
						</>
					)}
				</div>

				{hasNothingToTune ? (
					<div className="relative text-xs py-10" style={{ color: theme.colors.textDim }}>
						This agent exposes no model or effort options.
					</div>
				) : !loaded && !hasModels && !hasEfforts ? (
					<div className="relative text-xs py-10" style={{ color: theme.colors.textDim }}>
						Loading options...
					</div>
				) : (
					<>
						{/* Model - the vertical axis */}
						{hasModels && (
							<div className="relative w-full flex flex-col items-center gap-2">
								<div
									className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]"
									style={{ color: theme.colors.textDim }}
								>
									<Sparkles className="w-3 h-3" style={{ color: theme.colors.accent }} />
									<span>Model</span>
								</div>

								<div
									className="relative w-full"
									style={{
										height: wheelHeight,
										// Fading the ends is what sells the wheel as continuous:
										// rows leave by dissolving rather than by being clipped.
										maskImage:
											'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
										WebkitMaskImage:
											'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
									}}
									onWheel={handleWheelScroll}
								>
									{/* The gate the selected row sits in. Drawn behind the rows,
									    fixed at the centre - the wheel moves, this does not. */}
									<div
										aria-hidden
										className="absolute left-0 right-0 top-1/2 -translate-y-1/2 pointer-events-none"
										style={{ height: ROW_HEIGHT }}
									>
										<div
											className="absolute rounded-full"
											style={{
												inset: '0 12%',
												backgroundColor: theme.colors.accent,
												filter: 'blur(26px)',
												opacity: 0.3,
											}}
										/>
										<div
											className="absolute inset-0 rounded-lg"
											style={{
												background: `linear-gradient(90deg, ${theme.colors.accent}00, ${theme.colors.accent}22 22%, ${theme.colors.accent}22 78%, ${theme.colors.accent}00)`,
												borderTop: `1px solid ${theme.colors.accent}40`,
												borderBottom: `1px solid ${theme.colors.accent}40`,
											}}
										/>
										<span
											className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full"
											style={{ backgroundColor: theme.colors.accent }}
										/>
										<span
											className="absolute right-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full"
											style={{ backgroundColor: theme.colors.accent }}
										/>
									</div>

									{wheelSlots.map(renderWheelRow)}
								</div>

								{/* Fixed height so the composition doesn't shift as the
								    caption changes length between models. */}
								<div
									className="h-4 text-[10px] uppercase tracking-[0.14em] truncate max-w-full"
									style={{ color: theme.colors.textDim }}
								>
									{wheelCaption}
								</div>
							</div>
						)}

						{/* Effort - the horizontal axis, drawn as the scale it is */}
						{hasEfforts && (
							<div className="relative w-full flex flex-col items-center gap-2.5">
								<div
									className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]"
									style={{ color: theme.colors.textDim }}
								>
									<Gauge className="w-3 h-3" style={{ color: theme.colors.warning }} />
									<span>Effort</span>
								</div>

								{/* items-start, not items-end: '(default)' has no level bar, and
								    aligning on the bar baseline would drop its pill below the
								    rest of the row. Every option pads to the same total height
								    instead, so the pills share a line and the bars share a floor. */}
								<div className="flex items-start justify-center gap-1.5 flex-wrap">
									{hasDefaultEffort && (
										<>
											{renderEffortOption('')}
											<span
												aria-hidden
												className="self-center w-px h-5 mx-1 shrink-0"
												style={{ backgroundColor: theme.colors.border }}
											/>
										</>
									)}
									{effortScale.map((effort, index) => renderEffortOption(effort, index))}
								</div>
							</div>
						)}
					</>
				)}

				{/* The legend is the button row: every hint echoes its key, and the
				    two that commit or abandon are clickable for pointer-only users. */}
				<div
					className="relative flex items-center gap-1 rounded-full px-2.5 py-1.5 backdrop-blur-md"
					style={{
						backgroundColor: `${theme.colors.bgMain}cc`,
						border: `1px solid ${theme.colors.border}`,
						boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
					}}
				>
					{hasModels && (
						<KeycapHint
							theme={theme}
							keys={['↑', '↓']}
							label="Model"
							tone="accent"
							pressed={flashedKey === 'up' || flashedKey === 'down'}
						/>
					)}
					{hasEfforts && (
						<KeycapHint
							theme={theme}
							keys={['←', '→']}
							label="Effort"
							tone="warning"
							pressed={flashedKey === 'left' || flashedKey === 'right'}
						/>
					)}
					<span
						aria-hidden
						className="w-px h-4 mx-1 shrink-0"
						style={{ backgroundColor: theme.colors.border }}
					/>
					<KeycapHint
						theme={theme}
						keys={['↵']}
						label="Apply"
						tone="accent"
						pressed={flashedKey === 'enter'}
						onClick={hasNothingToTune ? undefined : handleConfirm}
						title="Apply model and effort (Enter)"
						testId="model-effort-apply"
					/>
					<KeycapHint
						theme={theme}
						keys={['esc']}
						label="Cancel"
						pressed={flashedKey === 'escape'}
						onClick={onClose}
						title="Cancel (Esc)"
						testId="model-effort-cancel"
					/>
				</div>
			</div>
		</div>,
		document.body
	);
}
