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

type ConcertoPitch = 'C5' | 'D5' | 'E5' | 'F5' | 'G5';

const PHASE_PITCH_CONTOURS: Record<ConcertoCreationPhase, readonly ConcertoPitch[]> = {
	composing: ['C5', 'D5', 'E5', 'G5', 'F5', 'E5', 'D5', 'C5'],
	refining: ['E5', 'G5', 'F5', 'G5', 'E5', 'F5', 'D5', 'E5'],
	arranging: ['G5', 'E5', 'F5', 'D5', 'E5', 'C5', 'D5', 'C5'],
	reviewing: ['F5', 'E5', 'G5', 'E5', 'D5', 'F5', 'D5', 'C5'],
	testing: ['G5', 'F5', 'E5', 'D5', 'C5', 'D5', 'C5', 'C5'],
};

const PITCH_RANK: Record<ConcertoPitch, number> = {
	G5: 0,
	F5: 1,
	E5: 2,
	D5: 3,
	C5: 4,
};

function pitchFor(track: ConcertoCreationTrack, noteIndex: number, number: number): ConcertoPitch {
	const contour = PHASE_PITCH_CONTOURS[track.phase];
	return contour[(noteIndex + number - 1) % contour.length];
}

function noteTopForPitch(pitch: ConcertoPitch, laneHeight: number, triad: boolean): number {
	const ornamentPadding = triad ? 3 : 0;
	const minimum = ornamentPadding;
	const maximum = Math.max(minimum, laneHeight - 6 - ornamentPadding);
	return minimum + (PITCH_RANK[pitch] / 4) * (maximum - minimum);
}

function staffBackground(color: string): string {
	return [10, 30, 50, 70, 90]
		.map(
			(position) =>
				`linear-gradient(to bottom, transparent calc(${position}% - 0.5px), ${color} calc(${position}% - 0.5px), ${color} calc(${position}% + 0.5px), transparent calc(${position}% + 0.5px))`
		)
		.join(',');
}

function TrackPhrase({
	track,
	number,
	voiceIndex,
	voiceCount,
	staffHeight,
	theme,
}: {
	track: ConcertoCreationTrack;
	number: number;
	voiceIndex: number;
	voiceCount: number;
	staffHeight: number;
	theme: Theme;
}) {
	const beamTop = 1;
	const laneHeight = staffHeight / voiceCount;
	const laneTop = voiceIndex * laneHeight;
	const noteValues = track.notes.map((note) => note.value);
	const noteHeadWidth = track.steps >= 7 ? 6 : track.steps >= 5 ? 7 : 8;
	const noteHeadHeight = track.steps >= 7 ? 5 : 6;
	const commonNoteValue = noteValues.every((value) => value === noteValues[0])
		? noteValues[0]
		: 'mixed';
	const notePattern = track.notes
		.map(
			(note) =>
				note.value +
				(note.dotted ? '+dotted' : '') +
				(note.triad ? '+triad' : '') +
				(note.tie ? '+tie' : '')
		)
		.join(',');
	const label = `${track.title}: ${PHASE_LABELS[track.phase]}, step ${track.step} of ${track.steps}`;

	return (
		<span
			data-testid={`concerto-note-${track.movementId}`}
			data-concerto-phase={track.phase}
			data-concerto-step={track.step}
			data-concerto-steps={track.steps}
			data-note-value={commonNoteValue}
			data-note-pattern={notePattern}
			data-voice-index={voiceIndex}
			className="absolute inset-x-0"
			style={{ top: laneTop, height: laneHeight }}
			title={`${number}. ${label}`}
			aria-label={label}
		>
			{track.notes.slice(0, -1).map((note, noteIndex) => {
				const next = track.notes[noteIndex + 1];
				if (note.value === 'quarter' || next.value === 'quarter') return null;
				const left = ((noteIndex + 1) * 100) / (track.steps + 1);
				const nextLeft = ((noteIndex + 2) * 100) / (track.steps + 1);
				return (
					<span key={`beam-${noteIndex}`} aria-hidden="true">
						<span
							data-testid={`concerto-beam-${track.movementId}-${noteIndex + 1}-1`}
							className="absolute h-px"
							style={{
								left: `${left}%`,
								top: beamTop,
								width: `${nextLeft - left}%`,
								backgroundColor: theme.colors.accent,
								opacity: 0.8,
							}}
						/>
						{note.value === 'sixteenth' && next.value === 'sixteenth' && (
							<span
								data-testid={`concerto-beam-${track.movementId}-${noteIndex + 1}-2`}
								className="absolute h-px"
								style={{
									left: `${left}%`,
									top: beamTop + 3,
									width: `${nextLeft - left}%`,
									backgroundColor: theme.colors.accent,
									opacity: 0.65,
								}}
							/>
						)}
					</span>
				);
			})}
			{track.notes.map((note, noteIndex) => {
				if (!note.tie || noteIndex === track.steps - 1) return null;
				const pitch = pitchFor(track, noteIndex, number);
				const nextPitch = pitchFor(track, noteIndex + 1, number);
				const noteTop = noteTopForPitch(pitch, laneHeight, note.triad === true);
				const nextNote = track.notes[noteIndex + 1];
				const nextNoteTop = noteTopForPitch(nextPitch, laneHeight, nextNote.triad === true);
				const left = ((noteIndex + 1) * 100) / (track.steps + 1);
				const nextLeft = ((noteIndex + 2) * 100) / (track.steps + 1);
				return (
					<span
						key={`tie-${noteIndex}`}
						data-testid={`concerto-tie-${track.movementId}-${noteIndex + 1}`}
						className="absolute h-1 rounded-[50%] border-t"
						style={{
							left: `${left + 2}%`,
							top: Math.min(laneHeight - 4, Math.max(noteTop, nextNoteTop) + 5),
							width: `${Math.max(4, nextLeft - left - 4)}%`,
							borderColor: theme.colors.accent,
							opacity: 0.65,
						}}
						aria-hidden="true"
					/>
				);
			})}
			{track.notes.map((note, noteIndex) => {
				const noteNumber = noteIndex + 1;
				const noteState =
					noteNumber < track.step ? 'complete' : noteNumber === track.step ? 'active' : 'pending';
				const pitch = pitchFor(track, noteIndex, number);
				const noteTop = noteTopForPitch(pitch, laneHeight, note.triad === true);
				const left = `${(noteNumber * 100) / (track.steps + 1)}%`;
				const filled = noteState !== 'pending';
				const connectedBefore =
					noteIndex > 0 &&
					note.value !== 'quarter' &&
					track.notes[noteIndex - 1].value !== 'quarter';
				const connectedAfter =
					noteIndex < track.steps - 1 &&
					note.value !== 'quarter' &&
					track.notes[noteIndex + 1].value !== 'quarter';
				return (
					<span
						key={noteNumber}
						data-testid={`concerto-subnote-${track.movementId}-${noteNumber}`}
						data-note-state={noteState}
						data-note-value={note.value}
						data-dotted={note.dotted ? 'true' : 'false'}
						data-triad={note.triad ? 'true' : 'false'}
						data-tie={note.tie ? 'true' : 'false'}
						data-flashing={noteState === 'active' ? 'true' : 'false'}
						data-pitch={pitch}
						className={`absolute inset-y-0 w-0 ${noteState === 'active' ? 'animate-pulse' : ''}`}
						style={{ left }}
						aria-hidden="true"
					>
						<span
							className="absolute w-px"
							style={{
								top: note.value === 'quarter' ? Math.max(1, noteTop - 7) : beamTop,
								height: note.value === 'quarter' ? 8 : Math.max(5, noteTop - beamTop + 2),
								backgroundColor: theme.colors.accent,
								opacity: noteState === 'pending' ? 0.4 : 0.9,
							}}
						/>
						{note.value !== 'quarter' && !connectedBefore && !connectedAfter && (
							<>
								<span
									className="absolute h-px w-1.5 origin-left rotate-[18deg]"
									style={{
										top: beamTop,
										backgroundColor: theme.colors.accent,
										opacity: noteState === 'pending' ? 0.4 : 0.8,
									}}
								/>
								{note.value === 'sixteenth' && (
									<span
										className="absolute h-px w-1.5 origin-left rotate-[18deg]"
										style={{
											top: beamTop + 3,
											backgroundColor: theme.colors.accent,
											opacity: noteState === 'pending' ? 0.4 : 0.65,
										}}
									/>
								)}
							</>
						)}
						{(note.triad ? [-3, 0, 3] : [0]).map((offset) => (
							<span
								key={offset}
								className="absolute -translate-x-1/2 -rotate-[18deg] rounded-full"
								style={{
									top: noteTop + offset,
									width: noteHeadWidth,
									height: noteHeadHeight,
									backgroundColor: filled ? theme.colors.accent : theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.accent}`,
									opacity: noteState === 'pending' ? 0.55 : noteState === 'complete' ? 0.72 : 1,
									boxShadow: noteState === 'active' ? `0 0 5px ${theme.colors.accent}` : undefined,
								}}
							/>
						))}
						{note.dotted && (
							<span
								className="absolute h-1 w-1 rounded-full"
								style={{
									left: noteHeadWidth / 2 + 1,
									top: noteTop + 3,
									backgroundColor: theme.colors.accent,
									opacity: noteState === 'pending' ? 0.55 : 0.9,
								}}
							/>
						)}
						{noteState === 'active' && (
							<span
								className="absolute -top-0.5 left-1 text-[6px] font-bold leading-none"
								style={{ color: theme.colors.accent }}
							>
								{number}
							</span>
						)}
					</span>
				);
			})}
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
	const staffHeight = Math.max(24, activeTracks.length * 14);
	const densestPhrase = Math.max(1, ...activeTracks.map((track) => track.steps));
	const scoreWidth = Math.min(400, 300 + Math.max(0, densestPhrase - 3) * 20);

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
				className="mx-auto mt-2 flex"
				style={{
					width: `min(${scoreWidth}px, calc(100% - 16px))`,
					height: staffHeight + 14,
				}}
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
								className="relative"
								style={{
									height: staffHeight,
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
									backgroundImage: staffBackground(theme.colors.border),
								}}
							>
								{phaseTracks.map((track) => (
									<TrackPhrase
										key={track.movementId}
										track={track}
										number={activeTracks.indexOf(track) + 1}
										voiceIndex={activeTracks.indexOf(track)}
										voiceCount={activeTracks.length}
										staffHeight={staffHeight}
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
						data-concerto-step={track.step}
						data-concerto-steps={track.steps}
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
