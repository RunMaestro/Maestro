/**
 * WidgetGallery
 *
 * Developer/preview surface for the shared widget library. It renders every
 * output widget and the starter input widgets with representative mock data and
 * the active theme, so the library is discoverable and demonstrably independent
 * of any Encore feature flag - it imports only the public `components/widgets`
 * barrel plus app modal infrastructure, never the Usage Dashboard, and renders
 * regardless of whether the Usage Dashboard Encore feature is enabled.
 *
 * This is NOT a user-facing feature. It's reached only via the "Debug: Widget
 * Gallery" command-palette entry and self-subscribes to the `widgetGallery`
 * modal in the modal store (so it can be mounted once, globally, and stays out
 * of the way until opened). Escape handling and focus come from the shared
 * `Modal` wrapper (which uses `useModalLayer`).
 */

import { memo, useState, type ReactNode } from 'react';
import {
	History,
	Bot,
	Timer,
	CheckCircle2,
	Activity,
	PieChart,
	Users,
	TrendingUp,
	ShieldAlert,
	SlidersHorizontal,
	ListOrdered,
} from 'lucide-react';
import type { Theme } from '../../types';
import { Modal } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalStore, selectModalOpen } from '../../stores/modalStore';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import {
	StatCardGrid,
	SectionCard,
	ActivityTimeline,
	TypeBreakdown,
	AgentActivityBars,
	SuccessFailureWidget,
	Sparkline,
	ChartTooltip,
	ChartErrorBoundary,
	Slider,
	RankedChoice,
	type StatCardDatum,
	type BarDatum,
	type DonutSlice,
	type TimelineBucket,
	type RankedChoiceValue,
	type RankedChoiceItem,
} from './index';

// --- Representative mock data (deterministic, no IPC) -----------------------

const TREND_A = [3, 5, 4, 7, 6, 9, 8, 12, 10, 14];
const TREND_B = [12, 10, 11, 8, 9, 6, 7, 5, 6, 4];

const TIMELINE: TimelineBucket[] = [
	{ auto: 2, user: 5, cue: 1 },
	{ auto: 4, user: 3, cue: 0 },
	{ auto: 1, user: 6, cue: 2 },
	{ auto: 6, user: 2, cue: 1 },
	{ auto: 3, user: 4, cue: 3 },
	{ auto: 5, user: 7, cue: 0 },
	{ auto: 2, user: 1, cue: 1 },
	{ auto: 7, user: 5, cue: 2 },
];

const RANKED_ITEMS: RankedChoiceItem[] = [
	{ id: 'speed', label: 'Speed' },
	{ id: 'accuracy', label: 'Accuracy' },
	{ id: 'cost', label: 'Cost' },
	{ id: 'readability', label: 'Readability' },
];

/** A child that throws on render so the ChartErrorBoundary demo has something to catch. */
function Boom(): ReactNode {
	throw new Error('Simulated widget render failure');
}

/** Section heading inside the gallery body. */
function GroupHeading({ theme, children }: { theme: Theme; children: ReactNode }) {
	return (
		<h3
			className="text-[11px] font-bold uppercase tracking-widest mb-3 mt-1"
			style={{ color: theme.colors.textDim }}
		>
			{children}
		</h3>
	);
}

interface WidgetGalleryProps {
	theme: Theme;
}

/**
 * Self-subscribing gallery modal. Mount once, globally; it renders nothing until
 * the `widgetGallery` modal is opened (via the debug command).
 */
export const WidgetGallery = memo(function WidgetGallery({ theme }: WidgetGalleryProps) {
	const open = useModalStore(selectModalOpen('widgetGallery'));
	const closeModal = useModalStore((s) => s.closeModal);

	// Controlled state for the input-widget demos.
	const [sliderValue, setSliderValue] = useState(42);
	const [ranked, setRanked] = useState<RankedChoiceValue>({
		orderedIds: RANKED_ITEMS.map((i) => i.id),
	});

	// Live cursor-anchored tooltip demo.
	const [tooltipAnchor, setTooltipAnchor] = useState<{ x: number; y: number } | null>(null);

	// ChartErrorBoundary demo toggle.
	const [boom, setBoom] = useState(false);

	if (!open) return null;

	const cards: StatCardDatum[] = [
		{
			label: 'Total Entries',
			value: 1284,
			icon: History,
			color: theme.colors.accent,
			trend: TREND_A,
		},
		{ label: 'Agents', value: 7, icon: Bot, color: theme.colors.accent },
		{
			label: 'Success Rate',
			value: 412,
			displayValue: '92%',
			caption: '412 ok · 36 failed',
			icon: CheckCircle2,
			color: theme.colors.success,
		},
		{
			label: 'Time Spent',
			value: 0,
			displayValue: '6h 24m',
			icon: Timer,
			color: theme.colors.warning,
			trend: TREND_B,
		},
	];

	const slices: DonutSlice[] = [
		{ label: 'User', value: 612, color: theme.colors.accent },
		{ label: 'Auto', value: 430, color: theme.colors.warning },
		{ label: 'Cue', value: 242, color: CUE_COLOR },
	];

	const agentBars: BarDatum[] = [
		{ label: 'Backend API', value: 320 },
		{ label: 'Frontend', value: 268 },
		{ label: 'Docs Writer', value: 142 },
		{ label: 'Test Runner', value: 96 },
		{ label: 'Refactor Bot', value: 54 },
	];

	return (
		<Modal
			theme={theme}
			title="Widget Gallery (dev preview)"
			priority={MODAL_PRIORITIES.DEBUG_WIDGET_GALLERY}
			onClose={() => closeModal('widgetGallery')}
			headerIcon={<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={760}
			maxWidthCss="92vw"
			maxHeight="88vh"
			closeOnBackdropClick
			testId="widget-gallery-modal"
		>
			<div className="flex flex-col gap-6 select-none">
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Every widget below is rendered from mock data with the active theme, straight from the
					shared <code>components/widgets</code> barrel - no Usage Dashboard, no Encore flag.
				</p>

				{/* ----------------------------- OUTPUT ----------------------------- */}
				<section>
					<GroupHeading theme={theme}>Output - production-grade</GroupHeading>

					<div className="flex flex-col gap-4">
						<StatCardGrid theme={theme} cards={cards} />

						<SectionCard theme={theme} title="Activity Timeline" icon={Activity}>
							<ActivityTimeline theme={theme} buckets={TIMELINE} />
						</SectionCard>

						<SectionCard theme={theme} title="Success vs Failure" icon={CheckCircle2}>
							<SuccessFailureWidget theme={theme} successCount={412} failureCount={36} />
						</SectionCard>

						<SectionCard theme={theme} title="Source Breakdown" icon={PieChart}>
							<TypeBreakdown theme={theme} slices={slices} />
						</SectionCard>

						<SectionCard theme={theme} title="Agent Activity" icon={Users}>
							<AgentActivityBars theme={theme} data={agentBars} />
						</SectionCard>

						<SectionCard theme={theme} title="Sparkline" icon={TrendingUp}>
							<div className="flex items-center gap-6">
								<div className="flex flex-col gap-1">
									<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
										Trend
									</span>
									<Sparkline data={TREND_A} color={theme.colors.accent} width={120} height={32} />
								</div>
								<div className="flex flex-col gap-1">
									<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
										Empty
									</span>
									<Sparkline data={[]} color={theme.colors.textDim} width={120} height={32} />
								</div>
							</div>
						</SectionCard>

						<SectionCard theme={theme} title="ChartTooltip" icon={Activity}>
							<div
								className="flex items-center justify-center h-20 rounded border border-dashed text-xs cursor-crosshair"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onMouseMove={(e) => setTooltipAnchor({ x: e.clientX, y: e.clientY })}
								onMouseLeave={() => setTooltipAnchor(null)}
							>
								Hover here to anchor a portaled tooltip
							</div>
							<ChartTooltip anchor={tooltipAnchor} theme={theme} testId="gallery-chart-tooltip">
								<div style={{ color: theme.colors.textMain }}>Tooltip follows the cursor</div>
							</ChartTooltip>
						</SectionCard>

						<SectionCard
							theme={theme}
							title="ChartErrorBoundary"
							icon={ShieldAlert}
							action={
								<button
									type="button"
									onClick={() => setBoom((b) => !b)}
									className="focus-ring text-[11px] px-2 py-1 rounded border"
									style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								>
									{boom ? 'Reset' : 'Simulate error'}
								</button>
							}
						>
							<ChartErrorBoundary
								theme={theme}
								chartName="Demo Widget"
								onRetry={() => setBoom(false)}
							>
								{boom ? (
									<Boom />
								) : (
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										Healthy child - use "Simulate error" to see the retry UI.
									</div>
								)}
							</ChartErrorBoundary>
						</SectionCard>
					</div>
				</section>

				{/* ------------------------------ INPUT ----------------------------- */}
				<section>
					<GroupHeading theme={theme}>Input - foundation for the dynamic interface</GroupHeading>

					<div className="flex flex-col gap-4">
						<SectionCard theme={theme} title="Slider" icon={SlidersHorizontal}>
							<Slider
								theme={theme}
								label="Temperature"
								value={sliderValue}
								onChange={setSliderValue}
								min={0}
								max={100}
								formatValue={(v) => `${v}%`}
							/>
						</SectionCard>

						<SectionCard theme={theme} title="RankedChoice" icon={ListOrdered}>
							<RankedChoice
								theme={theme}
								label="Rank what matters most"
								items={RANKED_ITEMS}
								value={ranked}
								onChange={setRanked}
							/>
							<p className="text-[11px] mt-2" style={{ color: theme.colors.textDim }}>
								Emitting: [{ranked.orderedIds.join(', ')}]
							</p>
						</SectionCard>
					</div>
				</section>
			</div>
		</Modal>
	);
});

export default WidgetGallery;
