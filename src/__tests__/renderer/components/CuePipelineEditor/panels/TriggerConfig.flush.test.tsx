/**
 * Regression test: TriggerConfig must flush its debounced `onUpdateNode`
 * writes when (a) the panel unmounts and (b) `flushAllPendingEdits()` runs
 * before a save.
 *
 * Without the flush hooks, toggling the GitHub re-trigger checkbox (or
 * editing the custom label) and immediately closing the panel or saving
 * inside the 300ms debounce window silently drops the edit, producing the
 * user-visible "toggle does not stick across app restart" bug.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';

import { TriggerConfig } from '../../../../../renderer/components/CuePipelineEditor/panels/triggers/TriggerConfig';
import { THEMES } from '../../../../../renderer/constants/themes';
import {
	flushAllPendingEdits,
	__resetPendingEditsRegistryForTests,
} from '../../../../../renderer/hooks/cue/pendingEditsRegistry';
import type { PipelineNode, TriggerNodeData } from '../../../../../shared/cue-pipeline-types';

const theme = THEMES['dracula'];

function makeTriggerNode(config: TriggerNodeData['config'] = {}): PipelineNode {
	return {
		id: 'trigger-1',
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType: 'github.pull_request',
			label: 'Pull Request',
			config: { repo: 'org/repo', poll_minutes: 5, ...config },
		} satisfies TriggerNodeData,
	};
}

describe('TriggerConfig debounced-edit flushing', () => {
	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});

	it('flushAllPendingEdits propagates a pending retrigger_on_comments toggle before the 300ms debounce', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode({ retrigger_on_comments: false })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		const checkbox = screen.getByRole('checkbox', {
			name: /Re-trigger on new activity/i,
		});
		fireEvent.click(checkbox);

		// Debounced, so no immediate write.
		expect(onUpdateNode).not.toHaveBeenCalled();

		// handleSave's flush path must pick up the pending toggle.
		flushAllPendingEdits();

		expect(onUpdateNode).toHaveBeenCalledTimes(1);
		const [nodeId, patch] = onUpdateNode.mock.calls[0];
		expect(nodeId).toBe('trigger-1');
		expect((patch as Partial<TriggerNodeData>).config?.retrigger_on_comments).toBe(true);
	});

	it('unmounting flushes a pending retrigger toggle (closing the panel preserves the edit)', () => {
		const onUpdateNode = vi.fn();
		const { unmount } = render(
			<TriggerConfig
				node={makeTriggerNode({ retrigger_on_comments: false })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.click(screen.getByRole('checkbox', { name: /Re-trigger on new activity/i }));
		expect(onUpdateNode).not.toHaveBeenCalled();

		unmount();

		expect(onUpdateNode).toHaveBeenCalledTimes(1);
		const [, patch] = onUpdateNode.mock.calls[0];
		expect((patch as Partial<TriggerNodeData>).config?.retrigger_on_comments).toBe(true);
	});

	it('registers and unregisters with the pending-edits registry on mount/unmount', () => {
		const onUpdateNode = vi.fn();
		const { unmount } = render(
			<TriggerConfig node={makeTriggerNode()} theme={theme} onUpdateNode={onUpdateNode} />
		);

		// Before unmount: a flush via the registry hits the panel.
		fireEvent.click(screen.getByRole('checkbox', { name: /Re-trigger on new activity/i }));
		flushAllPendingEdits();
		expect(onUpdateNode).toHaveBeenCalledTimes(1);

		onUpdateNode.mockClear();
		unmount();

		// After unmount the panel's flush callback must be removed from the
		// registry, otherwise registry leaks would keep firing stale closures.
		flushAllPendingEdits();
		expect(onUpdateNode).not.toHaveBeenCalled();
	});
});

describe('plugin source JSON save flushing', () => {
	it('clears a hidden invalid draft when the same node changes event type', () => {
		const node = makeTriggerNode();
		(node.data as TriggerNodeData).eventType = 'plugin.event';
		const update = vi.fn();
		const view = render(<TriggerConfig node={node} theme={theme} onUpdateNode={update} />);
		fireEvent.change(screen.getByLabelText('Source configuration (JSON)'), {
			target: { value: '{' },
		});
		expect(flushAllPendingEdits()).toBe(false);
		view.rerender(
			<TriggerConfig
				node={{ ...node, data: { ...node.data, eventType: 'app.startup' } }}
				theme={theme}
				onUpdateNode={update}
			/>
		);
		expect(flushAllPendingEdits()).toBe(true);
	});

	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});
	it.each(['save', 'unmount'])('retains focused edits on %s without a blur', (action) => {
		const node = makeTriggerNode();
		(node.data as TriggerNodeData).eventType = 'plugin.event';
		(node.data as TriggerNodeData).config = {
			plugin: { pluginId: 'com.example.fixture', topic: 'fixture.received', config: { old: true } },
		};
		const update = vi.fn();
		const view = render(<TriggerConfig node={node} theme={theme} onUpdateNode={update} />);
		const input = screen.getByLabelText('Source configuration (JSON)');
		input.focus();
		fireEvent.change(input, { target: { value: '{"new":{"value":2}}' } });
		expect(update).not.toHaveBeenCalled();
		if (action === 'save') expect(flushAllPendingEdits()).toBe(true);
		else view.unmount();
		expect(update).toHaveBeenLastCalledWith(node.id, {
			config: {
				plugin: {
					pluginId: 'com.example.fixture',
					topic: 'fixture.received',
					config: { new: { value: 2 } },
				},
			},
		});
	});
	it.each(['{', JSON.stringify({ huge: 'x'.repeat(17 * 1024) })])(
		'blocks save for invalid or oversized draft and recovers after correction',
		(draft) => {
			const node = makeTriggerNode();
			(node.data as TriggerNodeData).eventType = 'plugin.event';
			(node.data as TriggerNodeData).config = {
				plugin: { pluginId: 'com.example.fixture', topic: 'fixture.received', config: {} },
			};
			const update = vi.fn();
			render(<TriggerConfig node={node} theme={theme} onUpdateNode={update} />);
			const input = screen.getByLabelText('Source configuration (JSON)');
			fireEvent.change(input, { target: { value: draft } });
			expect(flushAllPendingEdits()).toBe(false);
			expect(screen.getByRole('alert')).toHaveTextContent('Enter valid JSON up to 16 KiB.');
			expect(update).not.toHaveBeenCalled();
			fireEvent.change(input, { target: { value: '{"valid":true}' } });
			expect(flushAllPendingEdits()).toBe(true);
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			expect(update).toHaveBeenLastCalledWith(
				node.id,
				expect.objectContaining({
					config: expect.objectContaining({
						plugin: expect.objectContaining({ config: { valid: true } }),
					}),
				})
			);
		}
	);
});
