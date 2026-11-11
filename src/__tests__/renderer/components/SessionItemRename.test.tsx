/**
 * @fileoverview Tests for the SessionItem inline rename field (the Left Bar
 * agent rename). Enter commits through blur, except while an IME composition is
 * active: that Enter confirms a candidate and must stay with the input method.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

function renderEditing() {
	const onFinishRename = vi.fn();
	render(
		<SessionItem
			variant="flat"
			theme={mockTheme}
			session={createMockSession({ name: 'Reviewer' })}
			isActive={false}
			isKeyboardSelected={false}
			isDragging={false}
			isEditing
			leftSidebarOpen
			onSelect={vi.fn()}
			onDragStart={vi.fn()}
			onContextMenu={vi.fn()}
			onFinishRename={onFinishRename}
			onStartRename={vi.fn()}
			onToggleBookmark={vi.fn()}
		/>
	);
	const input = screen.getByDisplayValue('Reviewer') as HTMLInputElement;
	input.focus();
	return { input, onFinishRename };
}

describe('SessionItem rename field', () => {
	it('commits on a normal Enter', () => {
		const { input, onFinishRename } = renderEditing();
		fireEvent.change(input, { target: { value: 'Reviewer 2' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onFinishRename).toHaveBeenCalledWith('Reviewer 2');
	});

	it('leaves an Enter during an IME composition to the input method (isComposing)', () => {
		const { input, onFinishRename } = renderEditing();
		const handled = fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
		expect(handled).toBe(true);
		expect(onFinishRename).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(input);
	});

	it('leaves an Enter during an IME composition to the input method (keyCode 229)', () => {
		const { input, onFinishRename } = renderEditing();
		const handled = fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
		expect(handled).toBe(true);
		expect(onFinishRename).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(input);
	});
});
