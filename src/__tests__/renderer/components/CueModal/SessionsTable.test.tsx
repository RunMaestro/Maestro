/**
 * Tests for SessionsTable.
 *
 * Key contract: the Run Now button must deduplicate subscriptions by
 * pipeline_name before firing. Firing every sub individually when subs share
 * a pipeline_name causes N×N fires because the engine's anchor-group logic
 * re-fires all siblings for each individual trigger call.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionsTable } from '../../../../renderer/components/CueModal/SessionsTable';
import type { Theme } from '../../../../renderer/types';
import type { CueSessionStatus } from '../../../../renderer/hooks/useCue';
import type { CuePipeline, CueGraphSession } from '../../../../shared/cue-pipeline-types';
import type { CueSubscription } from '../../../../shared/cue';

// ─── Theme mock ───────────────────────────────────────────────────────────────

const theme = {
	colors: {
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		bgActivity: '#111',
		bgMain: '#222',
		accent: '#06b6d4',
		error: '#f00',
		success: '#0f0',
	},
} as unknown as Theme;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(id = 's1', name = 'Agent-1', enabled = true): CueSessionStatus {
	return {
		sessionId: id,
		sessionName: name,
		toolType: 'claude-code',
		projectRoot: `/proj/${id}`,
		enabled,
		subscriptionCount: 1,
		activeRuns: 0,
	};
}

function makeSub(name: string, pipelineName?: string): CueSubscription {
	return {
		name,
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'go',
		interval_minutes: 60,
		...(pipelineName ? { pipeline_name: pipelineName } : {}),
	};
}

function makeGraphSession(sessionId: string, subs: CueSubscription[]): CueGraphSession {
	return { sessionId, sessionName: `S-${sessionId}`, toolType: 'claude-code', subscriptions: subs };
}

function makeProps(
	overrides: Partial<React.ComponentProps<typeof SessionsTable>> = {}
): React.ComponentProps<typeof SessionsTable> {
	return {
		sessions: [],
		theme,
		onViewInPipeline: vi.fn(),
		onEditYaml: vi.fn(),
		onRemoveCue: vi.fn(),
		onTriggerSubscription: vi.fn(),
		queueStatus: {},
		pipelines: [],
		graphSessions: [],
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionsTable', () => {
	it('renders empty-state message when sessions array is empty', () => {
		render(<SessionsTable {...makeProps()} />);
		expect(screen.getByText(/No sessions have a cue config file/)).toBeInTheDocument();
	});

	it('renders session name and agent type columns', () => {
		const session = makeSession('s1', 'MyAgent');
		render(<SessionsTable {...makeProps({ sessions: [session] })} />);
		expect(screen.getByText('MyAgent')).toBeInTheDocument();
		expect(screen.getByText('claude-code')).toBeInTheDocument();
	});

	it('Run Now is hidden when session is disabled (enabled=false)', () => {
		const session = makeSession('s1', 'A', false);
		const gs = makeGraphSession('s1', [makeSub('sub1')]);
		render(<SessionsTable {...makeProps({ sessions: [session], graphSessions: [gs] })} />);
		expect(screen.queryByText('Run Now')).not.toBeInTheDocument();
	});

	it('Run Now is hidden when session has no subscriptions in graph data', () => {
		const session = makeSession('s1', 'A', true);
		const gs = makeGraphSession('s1', []); // no subs
		render(<SessionsTable {...makeProps({ sessions: [session], graphSessions: [gs] })} />);
		expect(screen.queryByText('Run Now')).not.toBeInTheDocument();
	});

	it('Run Now fires each ungrouped sub exactly once', () => {
		const onTrigger = vi.fn();
		const session = makeSession('s1');
		const gs = makeGraphSession('s1', [makeSub('subA'), makeSub('subB')]);
		render(
			<SessionsTable
				{...makeProps({
					sessions: [session],
					graphSessions: [gs],
					onTriggerSubscription: onTrigger,
				})}
			/>
		);
		fireEvent.click(screen.getByText('Run Now'));
		expect(onTrigger).toHaveBeenCalledTimes(2);
		expect(onTrigger).toHaveBeenCalledWith('subA');
		expect(onTrigger).toHaveBeenCalledWith('subB');
	});

	it('Run Now fires only ONE sub per pipeline_name group — not all N', () => {
		const onTrigger = vi.fn();
		const session = makeSession('s1');
		// Three subs, all in the same pipeline group "Deploy"
		const gs = makeGraphSession('s1', [
			makeSub('sub1', 'Deploy'),
			makeSub('sub2', 'Deploy'),
			makeSub('sub3', 'Deploy'),
		]);
		render(
			<SessionsTable
				{...makeProps({
					sessions: [session],
					graphSessions: [gs],
					onTriggerSubscription: onTrigger,
				})}
			/>
		);
		fireEvent.click(screen.getByText('Run Now'));
		// Engine fires the whole group via anchor-group logic — only fire the first sub once
		expect(onTrigger).toHaveBeenCalledTimes(1);
		expect(onTrigger).toHaveBeenCalledWith('sub1');
	});

	it('Run Now fires one sub per pipeline_name group across N groups', () => {
		const onTrigger = vi.fn();
		const session = makeSession('s1');
		const gs = makeGraphSession('s1', [
			makeSub('a1', 'Pipeline-A'),
			makeSub('a2', 'Pipeline-A'),
			makeSub('b1', 'Pipeline-B'),
			makeSub('b2', 'Pipeline-B'),
			makeSub('c1'), // ungrouped — fires individually
		]);
		render(
			<SessionsTable
				{...makeProps({
					sessions: [session],
					graphSessions: [gs],
					onTriggerSubscription: onTrigger,
				})}
			/>
		);
		fireEvent.click(screen.getByText('Run Now'));
		// a1 (first in A), b1 (first in B), c1 (ungrouped) = 3 calls
		expect(onTrigger).toHaveBeenCalledTimes(3);
		expect(onTrigger).toHaveBeenCalledWith('a1');
		expect(onTrigger).toHaveBeenCalledWith('b1');
		expect(onTrigger).toHaveBeenCalledWith('c1');
	});

	it('Run Now fires both subs when same pipeline_name and same event but different interval', () => {
		const onTrigger = vi.fn();
		const session = makeSession('s1');
		// Same pipeline_name, same event — but different interval_minutes → different composite keys
		const gs = makeGraphSession('s1', [
			{
				name: 'fast',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 5,
				pipeline_name: 'Poller',
			},
			{
				name: 'slow',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 60,
				pipeline_name: 'Poller',
			},
		]);
		render(
			<SessionsTable
				{...makeProps({
					sessions: [session],
					graphSessions: [gs],
					onTriggerSubscription: onTrigger,
				})}
			/>
		);
		fireEvent.click(screen.getByText('Run Now'));
		expect(onTrigger).toHaveBeenCalledTimes(2);
		expect(onTrigger).toHaveBeenCalledWith('fast');
		expect(onTrigger).toHaveBeenCalledWith('slow');
	});

	it('Run Now fires both subs when same pipeline_name but different trigger types', () => {
		const onTrigger = vi.fn();
		const session = makeSession('s1');
		// Same pipeline_name, but different events → different trigger groups → both must fire
		const gs = makeGraphSession('s1', [
			{
				name: 'heartbeat-sub',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 60,
				pipeline_name: 'Deploy',
			},
			{
				name: 'file-sub',
				event: 'file.changed',
				enabled: true,
				prompt: 'p',
				watch: 'src/**',
				pipeline_name: 'Deploy',
			},
		]);
		render(
			<SessionsTable
				{...makeProps({
					sessions: [session],
					graphSessions: [gs],
					onTriggerSubscription: onTrigger,
				})}
			/>
		);
		fireEvent.click(screen.getByText('Run Now'));
		expect(onTrigger).toHaveBeenCalledTimes(2);
		expect(onTrigger).toHaveBeenCalledWith('heartbeat-sub');
		expect(onTrigger).toHaveBeenCalledWith('file-sub');
	});

	it('fan-out tooltip shows agent count when fan_out.length > 1', () => {
		const session = makeSession('s1');
		const sub: CueSubscription = {
			...makeSub('fan-sub'),
			fan_out: ['Agent1', 'Agent2', 'Agent3'],
		};
		const gs = makeGraphSession('s1', [sub]);
		render(<SessionsTable {...makeProps({ sessions: [session], graphSessions: [gs] })} />);
		const btn = screen.getByTitle(/fans out to 3 agents/);
		expect(btn).toBeInTheDocument();
	});

	it('renders multiple session rows', () => {
		const sessions = [makeSession('s1', 'AgentOne'), makeSession('s2', 'AgentTwo')];
		render(<SessionsTable {...makeProps({ sessions })} />);
		expect(screen.getByText('AgentOne')).toBeInTheDocument();
		expect(screen.getByText('AgentTwo')).toBeInTheDocument();
	});
});
