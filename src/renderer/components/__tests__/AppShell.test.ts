import { describe, expect, it } from 'vitest';
import { shouldRenderEmptyState, shouldRenderSessionNavigation } from '../AppShell';

describe('AppShell plugin workspace navigation', () => {
	it('keeps the existing session navigation mounted for a generic plugin host with zero native sessions', () => {
		expect(
			shouldRenderSessionNavigation({
				hasNativeSessions: false,
				hasPluginWorkspaceHost: true,
			})
		).toBe(true);
	});

	it('replaces the zero-session empty state after a plugin workspace destination is selected', () => {
		expect(
			shouldRenderEmptyState({
				hasNativeSessions: false,
				sessionsLoaded: true,
				isMobileLandscape: false,
				hasActivePluginWorkspace: true,
			})
		).toBe(false);
	});
});
