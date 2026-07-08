import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RightDrawer } from '../../../web/mobile/RightDrawer';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		triggerHaptic: vi.fn(),
		HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
	};
});

vi.mock('../../../web/hooks/useSwipeGestures', () => ({
	useSwipeGestures: () => ({
		handlers: {
			onTouchStart: vi.fn(),
			onTouchMove: vi.fn(),
			onTouchEnd: vi.fn(),
			onTouchCancel: vi.fn(),
		},
		offsetX: 0,
		offsetY: 0,
		isSwiping: false,
		swipeDirection: null,
		resetOffset: vi.fn(),
	}),
}));

vi.mock('../../../web/mobile/GitStatusPanel', () => ({
	GitStatusPanel: ({ onViewDiff }: { onViewDiff?: (path: string) => void }) => (
		<div>
			<span>Git panel</span>
			<button type="button" onClick={() => onViewDiff?.('src/App.tsx')}>
				View diff
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/AutoRunInline', () => ({
	AutoRunInline: ({ onOpenSetup }: { onOpenSetup?: () => void }) => (
		<div>
			<span>Auto Run inline</span>
			<button type="button" onClick={onOpenSetup}>
				Open setup
			</button>
		</div>
	),
}));

vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: (path: string) => `http://maestro.test${path}`,
}));

function renderDrawer(overrides: Partial<Parameters<typeof RightDrawer>[0]> = {}) {
	const props = {
		sessionId: 'session-1',
		activeTab: 'history' as const,
		autoRunState: null,
		gitStatus: {} as any,
		onClose: vi.fn(),
		onFileSelect: vi.fn(),
		projectPath: '/repo',
		onAutoRunOpenSetup: vi.fn(),
		sendRequest: vi.fn().mockResolvedValue({
			tree: [
				{
					name: 'src',
					type: 'folder',
					path: '/repo/src',
					children: [{ name: 'App.tsx', type: 'file', path: '/repo/src/App.tsx' }],
				},
				{ name: 'README.md', type: 'file', path: '/repo/README.md' },
			],
		}),
		send: vi.fn(),
		onViewDiff: vi.fn(),
		...overrides,
	};

	render(<RightDrawer {...(props as any)} />);

	return props;
}

describe('RightDrawer', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						entries: [{ id: 'h1', timestamp: '2026-06-18T12:00:00Z', summary: 'Fixed tests' }],
					}),
			})
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('renders history and closes from Escape after the drawer animation', async () => {
		vi.useFakeTimers();
		const { onClose } = renderDrawer();

		expect(screen.getByRole('dialog', { name: 'Right drawer' })).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('loads the file tree, filters it, and selects files', async () => {
		const { sendRequest, onFileSelect } = renderDrawer({ activeTab: 'files' });

		expect(await screen.findByText('src')).toBeInTheDocument();
		expect(sendRequest).toHaveBeenCalledWith('get_file_tree', {
			sessionId: 'session-1',
			path: '/repo',
			maxDepth: 3,
		});

		fireEvent.click(screen.getByText('src'));
		fireEvent.click(await screen.findByText('App.tsx'));
		expect(onFileSelect).toHaveBeenCalledWith('/repo/src/App.tsx');

		fireEvent.change(screen.getByPlaceholderText('Filter files...'), {
			target: { value: 'readme' },
		});
		expect(screen.getByText('README.md')).toBeInTheDocument();
		expect(screen.queryByText('src')).not.toBeInTheDocument();
	});

	it('switches to Auto Run and Git tab content', () => {
		const onAutoRunOpenSetup = vi.fn();
		const onViewDiff = vi.fn();
		renderDrawer({ onAutoRunOpenSetup, onViewDiff });

		fireEvent.click(screen.getByRole('tab', { name: 'Auto Run' }));
		expect(screen.getByText('Auto Run inline')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Open setup' }));
		expect(onAutoRunOpenSetup).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('tab', { name: 'Git' }));
		expect(screen.getByText('Git panel')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'View diff' }));
		expect(onViewDiff).toHaveBeenCalledWith('src/App.tsx');
	});
});
