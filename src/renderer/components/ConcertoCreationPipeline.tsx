/**
 * ConcertoCreationPipeline - a compact, always-on-top conductor score for
 * parallel Concerto work. The shared staff has one measure per phase and one
 * moving note per active Concerto.
 */

import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { GripHorizontal, Music2 } from 'lucide-react';
import type { Theme, ThinkingItem } from '../types';
import {
	type ConcertoCreationTrack,
	useConcertoCreationActivityStore,
} from '../stores/concertoCreationActivityStore';
import { CONCERTO_CREATION_PHASES, type ConcertoCreationPhase } from '../../shared/movement-types';
import { usePointerDrag } from '../hooks/utils/usePointerDrag';
import { useEventListener } from '../hooks/utils/useEventListener';

const PHASE_LABELS: Record<ConcertoCreationPhase, string> = {
	composing: 'Composing',
	refining: 'Refining',
	arranging: 'Arranging',
	reviewing: 'Reviewing',
	testing: 'Testing',
};

/** Above Movement Concertos (90000), below Cadenza and momentary feedback (100000). */
const CONCERTO_PIPELINE_Z = 95000;
const PIPELINE_EDGE_GAP = 12;
const PIPELINE_DEFAULT_BOTTOM = 64;
const PIPELINE_MIN_TOP = 44;

interface ConcertoCreationPipelineProps {
	thinkingItems: ThinkingItem[];
	theme: Theme;
	activeSessionId?: string;
	activeTabId?: string;
}

interface PipelinePosition {
	x: number;
	y: number;
}

function trackMatchesItem(track: ConcertoCreationTrack, item: ThinkingItem): boolean {
	return (
		track.sessionId === item.session.id &&
		track.tabId === (item.tab?.id ?? null) &&
		track.thinkingStartTime === (item.tab?.thinkingStartTime ?? item.session.thinkingStartTime)
	);
}

function TrackNote({
	track,
	number,
	position,
	total,
	theme,
}: {
	track: ConcertoCreationTrack;
	number: number;
	position: number;
	total: number;
	theme: Theme;
}) {
	const left = `${((position + 1) / (total + 1)) * 100}%`;
	const top = [3, 0, 6, 2][(number - 1) % 4];

	return (
		<span
			data-testid={`concerto-note-${track.movementId}`}
			data-concerto-phase={track.phase}
			className="absolute h-4 w-3 -translate-x-1/2 animate-pulse"
			style={{ left, top }}
			title={`${number}. ${track.title}: ${PHASE_LABELS[track.phase]}`}
			aria-label={`${track.title}: ${PHASE_LABELS[track.phase]}`}
		>
			<span
				className="absolute bottom-0 left-0 h-1.5 w-2.5 -rotate-[18deg] rounded-full"
				style={{
					backgroundColor: theme.colors.accent,
					border: `1px solid ${theme.colors.accent}`,
					boxShadow: `0 0 6px ${theme.colors.accent}`,
				}}
				aria-hidden="true"
			/>
			<span
				className="absolute bottom-1 left-2 h-3 w-px"
				style={{ backgroundColor: theme.colors.accent }}
				aria-hidden="true"
			/>
			<span
				className="absolute -right-1.5 -top-1 text-[7px] font-bold leading-none"
				style={{ color: theme.colors.accent }}
				aria-hidden="true"
			>
				{number}
			</span>
		</span>
	);
}

export const ConcertoCreationPipeline = memo(function ConcertoCreationPipeline({
	thinkingItems,
	theme,
	activeSessionId,
	activeTabId,
}: ConcertoCreationPipelineProps) {
	const tracks = useConcertoCreationActivityStore((state) => state.tracks);
	const panelRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<PipelinePosition | null>(null);
	const startDrag = usePointerDrag();
	const activeItem =
		(activeTabId &&
			thinkingItems.find(
				(item) => item.session.id === activeSessionId && item.tab?.id === activeTabId
			)) ||
		thinkingItems.find((item) => item.session.id === activeSessionId);
	const activeTracks = activeItem
		? tracks.filter((track) => trackMatchesItem(track, activeItem))
		: [];

	const clampPosition = (next: PipelinePosition): PipelinePosition => {
		const panel = panelRef.current;
		const width = panel?.offsetWidth ?? 430;
		const height = panel?.offsetHeight ?? 112;
		return {
			x: Math.min(
				Math.max(PIPELINE_EDGE_GAP, next.x),
				Math.max(PIPELINE_EDGE_GAP, window.innerWidth - width - PIPELINE_EDGE_GAP)
			),
			y: Math.min(
				Math.max(PIPELINE_MIN_TOP, next.y),
				Math.max(PIPELINE_MIN_TOP, window.innerHeight - height - PIPELINE_EDGE_GAP)
			),
		};
	};

	const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
		const panel = panelRef.current;
		if (!panel) return;
		const rect = panel.getBoundingClientRect();
		startDrag(event, (deltaX, deltaY) => {
			setPosition(clampPosition({ x: rect.left + deltaX, y: rect.top + deltaY }));
		});
	};

	useEventListener('resize', () => {
		setPosition((current) => (current ? clampPosition(current) : current));
	});

	if (!activeItem || activeTracks.length === 0) return null;

	return createPortal(
		<div
			ref={panelRef}
			className="fixed w-[min(430px,calc(100vw-24px))] select-none overflow-hidden rounded-xl shadow-xl backdrop-blur-md"
			style={{
				zIndex: CONCERTO_PIPELINE_Z,
				backgroundColor: `${theme.colors.bgSidebar}f2`,
				border: `1px solid ${theme.colors.accent}66`,
				boxShadow: `0 10px 32px ${theme.colors.accent}1f`,
				...(position
					? { left: position.x, top: position.y }
					: { right: PIPELINE_EDGE_GAP, bottom: PIPELINE_DEFAULT_BOTTOM }),
			}}
			data-testid="concerto-pipeline"
			aria-label="Concerto creation conductor"
			aria-live="polite"
		>
			<div
				data-testid="concerto-pipeline-drag-handle"
				className="flex h-7 cursor-grab items-center gap-1.5 px-2 active:cursor-grabbing"
				style={{ borderBottom: `1px solid ${theme.colors.border}` }}
				onPointerDown={onDragStart}
			>
				<Music2
					className="h-3.5 w-3.5 shrink-0"
					style={{ color: theme.colors.accent }}
					aria-hidden="true"
				/>
				<span className="text-[10px] font-semibold" style={{ color: theme.colors.textMain }}>
					Concerto score
				</span>
				<span className="text-[9px]" style={{ color: theme.colors.textDim }}>
					{activeTracks.length} {activeTracks.length === 1 ? 'part' : 'parts'}
				</span>
				<GripHorizontal
					className="ml-auto h-3.5 w-3.5"
					style={{ color: theme.colors.textDim }}
					aria-hidden="true"
				/>
			</div>

			<ol
				className="mx-auto mt-2 flex h-10"
				style={{ width: 'min(300px, calc(100% - 16px))' }}
				aria-label="Concerto creation score"
			>
				{CONCERTO_CREATION_PHASES.map((phase, phaseIndex) => {
					const phaseTracks = activeTracks.filter((track) => track.phase === phase);
					const phaseComplete = activeTracks.every(
						(track) => CONCERTO_CREATION_PHASES.indexOf(track.phase) > phaseIndex
					);
					const phaseActive = phaseTracks.length > 0;
					return (
						<li
							key={phase}
							data-testid={`concerto-measure-${phase}`}
							data-phase-state={phaseComplete ? 'complete' : phaseActive ? 'active' : 'pending'}
							className="min-w-0 flex-1"
						>
							<div
								className="relative h-6"
								style={{
									borderLeft: `1px solid ${phaseComplete || phaseActive ? `${theme.colors.accent}99` : theme.colors.border}`,
									borderRight:
										phaseIndex === CONCERTO_CREATION_PHASES.length - 1
											? `1px solid ${phaseActive ? theme.colors.accent : theme.colors.border}`
											: undefined,
									backgroundColor: phaseActive
										? `${theme.colors.accent}18`
										: phaseComplete
											? `${theme.colors.accent}08`
											: 'transparent',
									backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent 4px, ${theme.colors.border} 4px, ${theme.colors.border} 5px)`,
								}}
							>
								{phaseTracks.map((track, noteIndex) => (
									<TrackNote
										key={track.movementId}
										track={track}
										number={activeTracks.indexOf(track) + 1}
										position={noteIndex}
										total={phaseTracks.length}
										theme={theme}
									/>
								))}
							</div>
							<span
								className="mt-1 block text-center text-[8px] font-medium leading-none"
								style={{ color: phaseActive ? theme.colors.textMain : theme.colors.textDim }}
							>
								{PHASE_LABELS[phase]}
							</span>
						</li>
					);
				})}
			</ol>

			<div className="flex flex-wrap justify-center gap-x-3 gap-y-1 px-2 pb-2 pt-1">
				{activeTracks.map((track, index) => (
					<span
						key={track.movementId}
						data-testid={`concerto-track-${track.movementId}`}
						data-concerto-phase={track.phase}
						className="flex max-w-full items-baseline gap-1 text-[9px] leading-tight"
						style={{ color: theme.colors.textMain }}
					>
						<strong style={{ color: theme.colors.accent }}>{index + 1}</strong>
						<span>{track.title}</span>
					</span>
				))}
			</div>
		</div>,
		document.body
	);
});

ConcertoCreationPipeline.displayName = 'ConcertoCreationPipeline';
