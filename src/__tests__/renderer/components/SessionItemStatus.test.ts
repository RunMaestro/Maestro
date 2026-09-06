/**
 * getEnhancedStatusColor - the Left Bar's status dot and its tooltip.
 *
 * The dot is the only thing telling the user what an agent is doing without
 * opening it, so its label has to agree with the rest of the app. The case
 * these guard is a busy row that is busy for two different reasons: the
 * Thinking pill counts AI turns only, so a shell command labelled "Thinking"
 * makes the Left Bar look like it is lying about an agent the pill never lists.
 */

import { describe, it, expect } from 'vitest';
import { getEnhancedStatusColor } from '../../../renderer/components/SessionItem';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

/**
 * A Claude Code agent already bound to a provider session. Without the binding,
 * the hollow-dot case outranks everything below and every label reads
 * "No active Claude session".
 */
function boundSession(overrides: Parameters<typeof createMockSession>[0] = {}) {
	return createMockSession({ agentSessionId: 'provider-session-1', ...overrides });
}

function label(session: ReturnType<typeof boundSession>): string {
	return getEnhancedStatusColor(session, mockTheme, false).label;
}

describe('getEnhancedStatusColor busy labels', () => {
	it('calls a shell command a command, not thinking', () => {
		const session = boundSession({ state: 'busy', busySource: 'terminal' });

		const status = getEnhancedStatusColor(session, mockTheme, false);

		expect(status.label).toBe('Running command');
		// Still busy: only the wording changes, not the signal.
		expect(status.animate).toBe(true);
		expect(status.color).toBe(mockTheme.colors.warning);
	});

	it('calls an agent turn thinking', () => {
		expect(label(boundSession({ state: 'busy', busySource: 'ai' }))).toBe('Thinking');
	});

	// Legacy sessions and any path that marks a row busy without saying why: the
	// AI turn is the common case, so it stays the default.
	it('defaults to thinking when no busy source was recorded', () => {
		expect(label(boundSession({ state: 'busy', busySource: undefined }))).toBe('Thinking');
	});

	it('leaves the other states alone', () => {
		expect(label(boundSession({ state: 'idle' }))).toBe('Ready');
		expect(label(boundSession({ state: 'error' }))).toBe('Error');
		expect(label(boundSession({ state: 'connecting' }))).toBe('Connecting');
	});

	// Auto Run outranks agent state, so a busy row inside a batch says so
	// regardless of what is driving it.
	it('reports Auto Run ahead of the busy source', () => {
		const session = boundSession({ state: 'busy', busySource: 'terminal' });

		expect(getEnhancedStatusColor(session, mockTheme, true).label).toBe('Auto Run active');
	});
});
