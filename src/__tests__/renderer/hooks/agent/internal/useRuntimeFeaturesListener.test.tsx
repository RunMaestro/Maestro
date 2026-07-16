import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRuntimeFeaturesListener } from '../../../../../renderer/hooks/agent/internal/useRuntimeFeaturesListener';

const { ownedGate, openInSystemBrowser } = vi.hoisted(() => ({
	ownedGate: { current: (sessionId: string) => sessionId === 'owned-session' },
	openInSystemBrowser: vi.fn(),
}));
let onOpenExternalUrl: ((sessionId: string, url: string) => void) | undefined;

vi.mock('../../../../../renderer/hooks/agent/internal/useOwnedSessionGate', () => ({
	useOwnedSessionGate: () => ownedGate,
}));
vi.mock('../../../../../renderer/utils/openUrl', () => ({ openInSystemBrowser }));

const unsubscribe = vi.fn();
const mockProcess = {
	onRuntimeFeatures: vi.fn(() => unsubscribe),
	onApprovalRequest: vi.fn(() => unsubscribe),
	onApprovalCancelled: vi.fn(() => unsubscribe),
	onOpenExternalUrl: vi.fn((handler: (sessionId: string, url: string) => void) => {
		onOpenExternalUrl = handler;
		return unsubscribe;
	}),
	onComposerText: vi.fn(() => unsubscribe),
	onSessionTitle: vi.fn(() => unsubscribe),
};

beforeEach(() => {
	vi.clearAllMocks();
	onOpenExternalUrl = undefined;
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useRuntimeFeaturesListener', () => {
	it('opens broadcast URLs only in the owning Maestro window', () => {
		renderHook(() => useRuntimeFeaturesListener());

		onOpenExternalUrl!('foreign-session', 'https://example.com/foreign');
		expect(openInSystemBrowser).not.toHaveBeenCalled();

		onOpenExternalUrl!('owned-session', 'https://example.com/owned');
		expect(openInSystemBrowser).toHaveBeenCalledOnce();
		expect(openInSystemBrowser).toHaveBeenCalledWith('https://example.com/owned');
	});
});
