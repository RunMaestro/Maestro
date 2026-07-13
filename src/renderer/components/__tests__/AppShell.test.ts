import { describe, expect, it } from 'vitest';
import { resolveMainWorkspaceSurface } from '../AppShell';

describe('resolveMainWorkspaceSurface', () => {
	it('keeps a selected plugin workspace reachable when there are no native sessions', () => {
		expect(
			resolveMainWorkspaceSurface({
				hasNativeSessions: false,
				hasActiveGroupChat: false,
				isLogViewerOpen: false,
				hasActivePluginWorkspace: true,
			})
		).toBe('plugin');
	});
});
