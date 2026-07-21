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

	it('applies an async save result to the latest command list rather than a stale render snapshot', async () => {
		let resolveSave!: () => void;
		const save = new Promise<void>((resolve) => {
			resolveSave = resolve;
		});
		const { result } = renderHook(() =>
			useCommandPanelState<Command, null, { id: string; prompt: string }>({
				commands: [{ id: 'one', prompt: 'first', isModified: false }],
			})
		);

		const applySave = async () => {
			await save;
			result.current.replaceCommand('one', { prompt: 'saved', isModified: true });
		};
		const pendingSave = applySave();

		act(() => {
			result.current.setCommands([
				{ id: 'one', prompt: 'newly loaded', isModified: false },
				{ id: 'two', prompt: 'second', isModified: false },
			]);
			resolveSave();
		});
		await act(async () => {
			await pendingSave;
		});

		expect(result.current.commands).toEqual([
			{ id: 'one', prompt: 'saved', isModified: true },
			{ id: 'two', prompt: 'second', isModified: false },
		]);
	});
});
