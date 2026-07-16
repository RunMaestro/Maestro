import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCommandPanelState } from '../../../renderer/hooks/ui/useCommandPanelState';

type Command = { id: string; prompt: string; isModified: boolean };

describe('useCommandPanelState', () => {
	it('updates one command without losing concurrent state from the latest list', () => {
		const commands: Command[] = [
			{ id: 'one', prompt: 'first', isModified: false },
			{ id: 'two', prompt: 'second', isModified: false },
		];
		const { result } = renderHook(() =>
			useCommandPanelState<Command, null, { id: string; prompt: string }>({ commands })
		);

		act(() => {
			result.current.replaceCommand('two', { prompt: 'edited', isModified: true });
		});

		expect(result.current.commands).toEqual([
			{ id: 'one', prompt: 'first', isModified: false },
			{ id: 'two', prompt: 'edited', isModified: true },
		]);
	});

	it('owns expansion and edit reset independently of command data', () => {
		const { result } = renderHook(() =>
			useCommandPanelState<Command, null, { id: string; prompt: string }>({ commands: [] })
		);

		act(() => {
			result.current.toggleExpanded('command');
			result.current.setEditingCommand({ id: 'command', prompt: 'value' });
			result.current.cancelEditing();
		});

		expect(result.current.expandedCommands.has('command')).toBe(true);
		expect(result.current.editingCommand).toBeNull();
	});
});
