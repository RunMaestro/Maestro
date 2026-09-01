/**
 * Tests for `useNarrativeGroupLookup`.
 *
 * The hook is the one place Director's Notes turns Maestro's live session and
 * group state into the agent -> group mapping its bullets bucket by. The model
 * never supplies the group, so a session the store cannot resolve must fall
 * through to per-agent bucketing rather than inventing a header.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNarrativeGroupLookup } from '../../../../renderer/components/DirectorNotes/useNarrativeGroupLookup';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { Group } from '../../../../shared/types';

function group(overrides: Partial<Group> = {}): Group {
	return { id: 'g1', name: 'Maestro Core', emoji: '\u{1F3AC}', collapsed: false, ...overrides };
}

describe('useNarrativeGroupLookup', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: [], groups: [] });
	});

	it('resolves a grouped session to its group name and emoji', () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1', name: 'rc', groupId: 'g1' })],
			groups: [group()],
		});

		const { result } = renderHook(() => useNarrativeGroupLookup());

		expect(result.current('rc')).toEqual({ name: 'Maestro Core', emoji: '\u{1F3AC}' });
	});

	it('collapses two sessions in the same group onto one entry', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 's1', name: 'rc', groupId: 'g1' }),
				createMockSession({ id: 's2', name: 'Maestro', groupId: 'g1' }),
			],
			groups: [group()],
		});

		const { result } = renderHook(() => useNarrativeGroupLookup());

		expect(result.current('rc')).toEqual(result.current('Maestro'));
	});

	it('returns null for an ungrouped session', () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1', name: 'acappella', groupId: undefined })],
			groups: [group()],
		});

		const { result } = renderHook(() => useNarrativeGroupLookup());

		expect(result.current('acappella')).toBeNull();
	});

	// A dangling groupId is the case that matters: naming a group that no longer
	// exists would draw a header for something the user cannot see in the Left Bar.
	it('returns null when the session points at a group that no longer exists', () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1', name: 'rc', groupId: 'deleted' })],
			groups: [group()],
		});

		const { result } = renderHook(() => useNarrativeGroupLookup());

		expect(result.current('rc')).toBeNull();
	});

	it('returns null for an agent name the store has never seen', () => {
		const { result } = renderHook(() => useNarrativeGroupLookup());

		expect(result.current('ghost')).toBeNull();
	});

	// The synopsis manifest hands the model a sanitized display name, so the
	// string that comes back rarely matches the stored name byte for byte.
	it('matches through case and markdown punctuation', () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1', name: '**Maestro Cue**', groupId: 'g1' })],
			groups: [group()],
		});

		const { result } = renderHook(() => useNarrativeGroupLookup());

		expect(result.current('maestro cue')?.name).toBe('Maestro Core');
	});

	it('keeps one identity while sessions and groups are unchanged', () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1', name: 'rc', groupId: 'g1' })],
			groups: [group()],
		});

		const { result, rerender } = renderHook(() => useNarrativeGroupLookup());
		const first = result.current;
		rerender();

		expect(result.current).toBe(first);
	});
});
