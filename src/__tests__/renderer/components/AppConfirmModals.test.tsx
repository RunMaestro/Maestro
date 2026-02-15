/**
 * Tests for AppConfirmModals component
 *
 * Focuses on the quit confirmation agent list computation:
 * - Busy agents are included (state === 'busy', busySource === 'ai')
 * - Active auto-run sessions are included with "(Auto Run)" suffix
 * - Deduplication: agents that are both busy AND auto-running show without suffix
 * - Terminal sessions are excluded from busy agent count
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppConfirmModals } from '../../../renderer/components/AppModals';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, Session } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
	X: () => <svg data-testid="x-icon" />,
	Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="trash2-icon" className={className} style={style} />
	),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

function createMockSession(overrides: Partial<Session>): Session {
	return {
		id: 'session-1',
		name: 'Agent 1',
		state: 'idle',
		toolType: 'claude-code',
		cwd: '/tmp',
		...overrides,
	} as Session;
}

const defaultProps = {
	theme: testTheme,
	confirmModalOpen: false,
	confirmModalMessage: '',
	confirmModalOnConfirm: null,
	onCloseConfirmModal: vi.fn(),
	onConfirmQuit: vi.fn(),
	onCancelQuit: vi.fn(),
};

const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('AppConfirmModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('quit confirmation agent list', () => {
		it('includes busy AI agents in quit modal', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Busy Agent', state: 'busy', busySource: 'ai', toolType: 'claude-code' }),
				createMockSession({ id: 's2', name: 'Idle Agent', state: 'idle', toolType: 'claude-code' }),
			];

			renderWithLayerStack(
				<AppConfirmModals
					{...defaultProps}
					sessions={sessions}
					quitConfirmModalOpen={true}
				/>
			);

			expect(screen.getByText('Busy Agent')).toBeInTheDocument();
			expect(screen.queryByText('Idle Agent')).not.toBeInTheDocument();
			expect(screen.getByText(/1 agent is currently thinking/)).toBeInTheDocument();
		});

		it('excludes terminal sessions from busy agent count', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Terminal', state: 'busy', busySource: 'ai', toolType: 'terminal' }),
			];

			renderWithLayerStack(
				<AppConfirmModals
					{...defaultProps}
					sessions={sessions}
					quitConfirmModalOpen={true}
					activeBatchSessionIds={[]}
				/>
			);

			// Modal shouldn't appear in practice (no busy agents), but we test the filter
			// When 0 agents are active, the modal still renders since quitConfirmModalOpen=true
			expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
		});

		it('includes auto-running sessions with (Auto Run) suffix', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Auto Session', state: 'idle', toolType: 'claude-code' }),
			];

			renderWithLayerStack(
				<AppConfirmModals
					{...defaultProps}
					sessions={sessions}
					quitConfirmModalOpen={true}
					activeBatchSessionIds={['s1']}
				/>
			);

			expect(screen.getByText('Auto Session (Auto Run)')).toBeInTheDocument();
			expect(screen.getByText(/1 agent is currently active/)).toBeInTheDocument();
		});

		it('deduplicates agents that are both busy and auto-running', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Dual Agent', state: 'busy', busySource: 'ai', toolType: 'claude-code' }),
			];

			renderWithLayerStack(
				<AppConfirmModals
					{...defaultProps}
					sessions={sessions}
					quitConfirmModalOpen={true}
					activeBatchSessionIds={['s1']}
				/>
			);

			// Should show without "(Auto Run)" since it's already counted as busy
			expect(screen.getByText('Dual Agent')).toBeInTheDocument();
			expect(screen.queryByText('Dual Agent (Auto Run)')).not.toBeInTheDocument();
			expect(screen.getByText(/1 agent is/)).toBeInTheDocument();
		});

		it('combines busy agents and auto-run-only sessions', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Thinking Agent', state: 'busy', busySource: 'ai', toolType: 'claude-code' }),
				createMockSession({ id: 's2', name: 'Auto Runner', state: 'idle', toolType: 'claude-code' }),
			];

			renderWithLayerStack(
				<AppConfirmModals
					{...defaultProps}
					sessions={sessions}
					quitConfirmModalOpen={true}
					activeBatchSessionIds={['s2']}
				/>
			);

			expect(screen.getByText('Thinking Agent')).toBeInTheDocument();
			expect(screen.getByText('Auto Runner (Auto Run)')).toBeInTheDocument();
			expect(screen.getByText(/2 agents are currently active/)).toBeInTheDocument();
		});

		it('does not show quit modal when quitConfirmModalOpen is false', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Agent', state: 'busy', busySource: 'ai', toolType: 'claude-code' }),
			];

			renderWithLayerStack(
				<AppConfirmModals
					{...defaultProps}
					sessions={sessions}
					quitConfirmModalOpen={false}
				/>
			);

			expect(screen.queryByText('Quit Maestro?')).not.toBeInTheDocument();
		});
	});
});
