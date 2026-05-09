import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProcessDetailView } from '../../../../renderer/components/ProcessMonitor/ProcessDetailView';
import type { ProcessDetailData } from '../../../../renderer/components/ProcessMonitor/types';
import type { Theme } from '../../../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'test',
	mode: 'dark',
	colors: {
		bgMain: '#000',
		bgSidebar: '#111',
		bgActivity: '#222',
		textMain: '#fff',
		textDim: '#888',
		accent: '#7b2cbf',
		border: '#333',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
};

const baseDetail: ProcessDetailData = {
	processSessionId: 'session-1-ai-tab-a',
	pid: 12345,
	toolType: 'claude-code',
	cwd: '/Users/test/project',
	startTime: Date.now() - 60_000,
	command: '/usr/bin/claude',
	args: ['--no-color', 'chat'],
};

describe('ProcessDetailView', () => {
	it('renders the always-present metadata fields', () => {
		render(
			<ProcessDetailView theme={theme} detail={baseDetail} onBack={() => {}} onClose={() => {}} />
		);
		expect(screen.getByText('Process Details')).toBeInTheDocument();
		expect(screen.getByText('session-1-ai-tab-a')).toBeInTheDocument();
		expect(screen.getByText('12345')).toBeInTheDocument();
		expect(screen.getByText('claude-code')).toBeInTheDocument();
		expect(screen.getByText('/Users/test/project')).toBeInTheDocument();
		expect(screen.getByText('/usr/bin/claude --no-color chat')).toBeInTheDocument();
	});

	it('hides optional fields when not provided', () => {
		render(
			<ProcessDetailView theme={theme} detail={baseDetail} onBack={() => {}} onClose={() => {}} />
		);
		expect(screen.queryByText('Agent Session ID')).not.toBeInTheDocument();
		expect(screen.queryByText('Tab Name')).not.toBeInTheDocument();
		expect(screen.queryByText('Cue Subscription')).not.toBeInTheDocument();
		expect(screen.queryByText('AUTO RUN')).not.toBeInTheDocument();
	});

	it('renders Cue-specific fields when present', () => {
		render(
			<ProcessDetailView
				theme={theme}
				detail={{
					...baseDetail,
					cueSubscriptionName: 'heartbeat',
					cueEventType: 'time.heartbeat',
					cueSessionName: 'Sentry',
				}}
				onBack={() => {}}
				onClose={() => {}}
			/>
		);
		expect(screen.getByText('heartbeat')).toBeInTheDocument();
		expect(screen.getByText('time.heartbeat')).toBeInTheDocument();
		expect(screen.getByText('Sentry')).toBeInTheDocument();
	});

	it('shows the AUTO RUN badge when isAutoRun is true', () => {
		render(
			<ProcessDetailView
				theme={theme}
				detail={{ ...baseDetail, isAutoRun: true }}
				onBack={() => {}}
				onClose={() => {}}
			/>
		);
		expect(screen.getByText('AUTO RUN')).toBeInTheDocument();
	});

	it('renders the child-process table when present', () => {
		render(
			<ProcessDetailView
				theme={theme}
				detail={{
					...baseDetail,
					childProcesses: [
						{ pid: 200, command: '/usr/bin/git' },
						{ pid: 201, command: '/usr/bin/grep' },
					],
				}}
				onBack={() => {}}
				onClose={() => {}}
			/>
		);
		expect(screen.getByText('Running in Terminal')).toBeInTheDocument();
		expect(screen.getByText('PID 200')).toBeInTheDocument();
		expect(screen.getByText('/usr/bin/git')).toBeInTheDocument();
	});

	it('Back button triggers onBack', () => {
		const onBack = vi.fn();
		render(
			<ProcessDetailView theme={theme} detail={baseDetail} onBack={onBack} onClose={() => {}} />
		);
		fireEvent.click(screen.getByTitle('Back (Esc)'));
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it('Close button triggers onClose', () => {
		const onClose = vi.fn();
		render(
			<ProcessDetailView theme={theme} detail={baseDetail} onBack={() => {}} onClose={onClose} />
		);
		fireEvent.click(screen.getByTitle('Close'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders a sensible fallback when command/args are missing', () => {
		render(
			<ProcessDetailView
				theme={theme}
				detail={{ ...baseDetail, command: undefined, args: undefined }}
				onBack={() => {}}
				onClose={() => {}}
			/>
		);
		expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
	});
});
