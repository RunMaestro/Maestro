/**
 * Tests for the prompt-injection screen on a trigger node: where TriggerConfig
 * offers it, and what it stores on the trigger's config, which is what
 * `pipelineToYaml` writes to every subscription the trigger fans out into.
 *
 * The stored shape matters for the same reason the gate's does:
 * `triggerGroupKey` compares `screen_injection` and `injection_threshold` as
 * written, so a spelled-out default would stop a trigger grouping with its
 * own siblings.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';

import { TriggerConfig } from '../../../../../renderer/components/CuePipelineEditor/panels/triggers/TriggerConfig';
import { THEMES } from '../../../../../renderer/constants/themes';
import {
	flushAllPendingEdits,
	__resetPendingEditsRegistryForTests,
} from '../../../../../renderer/hooks/cue/pendingEditsRegistry';
import type {
	CueEventType,
	PipelineNode,
	TriggerNodeData,
} from '../../../../../shared/cue-pipeline-types';

const theme = THEMES['dracula'];

function makeTriggerNode(
	eventType: CueEventType,
	config: TriggerNodeData['config'] = {}
): PipelineNode {
	return {
		id: 'trigger-1',
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: { eventType, label: 'Trigger', config } satisfies TriggerNodeData,
	};
}

/** The config the panel last wrote to the node. */
function lastConfig(onUpdateNode: ReturnType<typeof vi.fn>): TriggerNodeData['config'] {
	flushAllPendingEdits();
	const [, patch] = onUpdateNode.mock.calls.at(-1)!;
	return (patch as Partial<TriggerNodeData>).config!;
}

function pickMode(label: string): void {
	fireEvent.click(screen.getByRole('button', { name: 'Prompt-injection screen' }));
	fireEvent.click(screen.getByText(label));
}

describe('TriggerConfig injection screen', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.localModels.taskReadiness).mockResolvedValue([]);
	});

	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});

	it('offers the screen on the triggers that carry text other people wrote', () => {
		const eventTypes: CueEventType[] = [
			'github.pull_request',
			'github.issue',
			'github.label',
			'task.pending',
			'webhook.received',
		];
		for (const eventType of eventTypes) {
			const { unmount } = render(
				<TriggerConfig node={makeTriggerNode(eventType)} theme={theme} onUpdateNode={vi.fn()} />
			);
			expect(screen.getByTestId('cue-injection-screen-field'), eventType).toBeInTheDocument();
			unmount();
		}
	});

	it('leaves it off triggers that have no untrusted text to score', () => {
		const eventTypes: CueEventType[] = [
			'time.heartbeat',
			'time.scheduled',
			'file.changed',
			'app.startup',
			'agent.completed',
			'cli.trigger',
		];
		for (const eventType of eventTypes) {
			const { unmount } = render(
				<TriggerConfig node={makeTriggerNode(eventType)} theme={theme} onUpdateNode={vi.fn()} />
			);
			expect(screen.queryByTestId('cue-injection-screen-field'), eventType).not.toBeInTheDocument();
			unmount();
		}
	});

	it('stores on and off as booleans beside the rest of the trigger config', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.issue', { repo: 'org/repo' })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		pickMode('Always screen');
		expect(lastConfig(onUpdateNode)).toEqual({ repo: 'org/repo', screen_injection: true });

		pickMode('Never screen');
		expect(lastConfig(onUpdateNode)).toEqual({ repo: 'org/repo', screen_injection: false });
	});

	it('stores the automatic mode as no key at all', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.issue', { repo: 'org/repo', screen_injection: true })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		pickMode('Automatic: screen commands that use this text');
		expect(lastConfig(onUpdateNode)).toEqual({ repo: 'org/repo' });
	});

	it('stores a threshold only when it is not the default', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('webhook.received', { screen_injection: true })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);
		const input = screen.getByTestId('cue-injection-threshold');

		fireEvent.change(input, { target: { value: '0.6' } });
		expect(lastConfig(onUpdateNode)).toMatchObject({
			screen_injection: true,
			injection_threshold: 0.6,
		});

		fireEvent.change(input, { target: { value: '0.8' } });
		expect(lastConfig(onUpdateNode)).not.toHaveProperty('injection_threshold');
	});

	it('drops the threshold when the screen is turned off', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.issue', {
					repo: 'org/repo',
					screen_injection: true,
					injection_threshold: 0.6,
				})}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		pickMode('Never screen');
		expect(lastConfig(onUpdateNode)).toEqual({ repo: 'org/repo', screen_injection: false });
	});

	it('keeps the gate when the screen changes, and the screen when the gate changes', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.issue', { repo: 'org/repo', gate: 'reports a bug' })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		pickMode('Always screen');
		fireEvent.change(screen.getByTestId('cue-gate-condition'), {
			target: { value: 'asks for a change' },
		});

		expect(lastConfig(onUpdateNode)).toEqual({
			repo: 'org/repo',
			gate: 'asks for a change',
			screen_injection: true,
		});
	});
});
