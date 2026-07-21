/**
 * Renderer-local progress tracks for the active Concerto creation cycle.
 *
 * A single agent turn may delegate several mockups to subagents. Each mockup
 * keeps its own phase while the ordinary ThinkingStatusPill continues to report
 * the parent agent process. The movement bridge has no originating session id,
 * so callers only attribute events when exactly one AI tab is busy.
 */

import { create } from 'zustand';
import { CONCERTO_CREATION_PHASES, type ConcertoCreationPhase } from '../../shared/movement-types';

export interface ConcertoCreationTrack {
	sessionId: string;
	tabId: string | null;
	thinkingStartTime: number;
	movementId: string;
	title: string;
	phase: ConcertoCreationPhase;
	width?: number;
	height?: number;
	revision?: number;
	updatedAt: number;
}

interface ConcertoCreationActivityStore {
	tracks: ConcertoCreationTrack[];
	upsertTrack: (track: Omit<ConcertoCreationTrack, 'updatedAt'>) => void;
	clearMovement: (movementId: string) => void;
	clear: () => void;
}

function sameTrack(left: ConcertoCreationTrack, right: Omit<ConcertoCreationTrack, 'updatedAt'>) {
	return (
		left.sessionId === right.sessionId &&
		left.tabId === right.tabId &&
		left.thinkingStartTime === right.thinkingStartTime &&
		left.movementId === right.movementId
	);
}

export const useConcertoCreationActivityStore = create<ConcertoCreationActivityStore>()((set) => ({
	tracks: [],
	upsertTrack: (track) =>
		set((state) => {
			const existingIndex = state.tracks.findIndex((candidate) => sameTrack(candidate, track));
			const existing = existingIndex < 0 ? undefined : state.tracks[existingIndex];
			const incomingPhase = CONCERTO_CREATION_PHASES.indexOf(track.phase);
			const existingPhase = existing ? CONCERTO_CREATION_PHASES.indexOf(existing.phase) : -1;
			const next = {
				...existing,
				...track,
				phase: existingPhase > incomingPhase && existing ? existing.phase : track.phase,
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
