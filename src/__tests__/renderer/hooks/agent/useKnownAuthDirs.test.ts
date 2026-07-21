import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_KNOWN_AUTH_DIRS } from '../../../../shared/authPaths';
import { useKnownAuthDirs } from '../../../../renderer/hooks/agent/useKnownAuthDirs';

describe('useKnownAuthDirs', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.agents.getKnownAuthDirs).mockReset();
	});

	it('clears local suggestions when disabled after loading them', async () => {
		const knownAuthDirs = {
			claudeConfigDirs: ['/Users/me/.claude'],
			codexHomes: ['/Users/me/.codex'],
		};
		vi.mocked(window.maestro.agents.getKnownAuthDirs).mockResolvedValue(knownAuthDirs);

		const { result, rerender } = renderHook((enabled: boolean) => useKnownAuthDirs(enabled), {
			initialProps: true,
		});

		await waitFor(() => {
			expect(result.current).toEqual(knownAuthDirs);
		});

		rerender(false);

		await waitFor(() => {
			expect(result.current).toEqual(EMPTY_KNOWN_AUTH_DIRS);
		});
		expect(window.maestro.agents.getKnownAuthDirs).toHaveBeenCalledTimes(1);
	});
});
