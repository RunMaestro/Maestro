/**
 * Renderer-local progress tracks for the active Concerto creation cycle.
 *
 * A single agent turn may delegate several mockups to subagents. Each mockup
 * keeps its own phase while the ordinary ThinkingStatusPill continues to report
 * the parent agent process. The movement bridge has no originating session id,
 * so callers only attribute events when exactly one AI tab is busy.
 */

import { create } from 'zustand';
import {
	CONCERTO_CREATION_PHASES,
	type ConcertoCreationPhase,
	type ConcertoProgressNote,
} from '../../shared/movement-types';

export interface ConcertoCreationTrack {
	sessionId: string;
	tabId: string | null;
	thinkingStartTime: number;
	movementId: string;
	title: string;
	phase: ConcertoCreationPhase;
	step: number;
	steps: number;
	notes: ConcertoProgressNote[];
	width?: number;
	height?: number;
	revision?: number;
	updatedAt: number;
}

type ConcertoCreationTrackUpdate = Omit<
	ConcertoCreationTrack,
	'updatedAt' | 'step' | 'steps' | 'notes'
> &
	Partial<Pick<ConcertoCreationTrack, 'step' | 'steps' | 'notes'>>;

interface ConcertoCreationActivityStore {
	tracks: ConcertoCreationTrack[];
	upsertTrack: (track: ConcertoCreationTrackUpdate) => void;
	clearMovement: (movementId: string) => void;
	clear: () => void;
}

function sameTrack(left: ConcertoCreationTrack, right: ConcertoCreationTrackUpdate) {
	return (
		left.sessionId === right.sessionId &&
		left.tabId === right.tabId &&
		left.thinkingStartTime === right.thinkingStartTime &&
		left.movementId === right.movementId
	);
}

function normalizeSteps(value: number | undefined): number {
	if (!Number.isInteger(value)) return 1;
	return Math.min(8, Math.max(1, value ?? 1));
}

function defaultNotes(steps: number): ConcertoProgressNote[] {
	const value = steps === 1 ? 'quarter' : steps <= 3 ? 'eighth' : 'sixteenth';
	return Array.from({ length: steps }, () => ({ value }));
}

function normalizeNotes(
	notes: ConcertoProgressNote[] | undefined,
	steps: number
): ConcertoProgressNote[] {
	if (!notes || notes.length !== steps) return defaultNotes(steps);
	return notes.map((note) => ({ ...note }));
}

function progressForUpdate(
	existing: ConcertoCreationTrack | undefined,
	track: ConcertoCreationTrackUpdate,
	incomingPhase: number,
	existingPhase: number
): Pick<ConcertoCreationTrack, 'phase' | 'step' | 'steps' | 'notes'> {
	if (existing && existingPhase > incomingPhase) {
		return {
			phase: existing.phase,
			step: existing.step,
			steps: existing.steps,
			notes: existing.notes,
		};
	}
	if (existing && existingPhase === incomingPhase) {
		const steps = track.steps === undefined ? existing.steps : normalizeSteps(track.steps);
		const incomingStep = track.step === undefined ? existing.step : normalizeSteps(track.step);
		const notes =
			track.notes === undefined && steps === existing.steps
				? existing.notes
				: normalizeNotes(track.notes, steps);
		return {
			phase: track.phase,
			step: Math.min(steps, Math.max(existing.step, incomingStep)),
			steps,
			notes,
		};
	}
	const steps = normalizeSteps(track.steps);
	return {
		phase: track.phase,
		step: Math.min(steps, normalizeSteps(track.step)),
		steps,
		notes: normalizeNotes(track.notes, steps),
	};
}

export const useConcertoCreationActivityStore = create<ConcertoCreationActivityStore>()((set) => ({
	tracks: [],
	upsertTrack: (track) =>
		set((state) => {
			const existingIndex = state.tracks.findIndex((candidate) => sameTrack(candidate, track));
			const existing = existingIndex < 0 ? undefined : state.tracks[existingIndex];
			const incomingPhase = CONCERTO_CREATION_PHASES.indexOf(track.phase);
			const existingPhase = existing ? CONCERTO_CREATION_PHASES.indexOf(existing.phase) : -1;
			const progress = progressForUpdate(existing, track, incomingPhase, existingPhase);
			const next = {
				...existing,
				...track,
				...progress,
				updatedAt: Date.now(),
			};
			if (existingIndex < 0) return { tracks: [...state.tracks, next] };
			const tracks = [...state.tracks];
			tracks[existingIndex] = next;
			return { tracks };
		}),
	clearMovement: (movementId) =>
		set((state) => ({
			tracks: state.tracks.filter((track) => track.movementId !== movementId),
		})),
	clear: () => set({ tracks: [] }),
}));
