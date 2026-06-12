import { render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useInputAreaAutosize } from '../../../../../renderer/components/InputArea/hooks/useInputAreaAutosize';

function Harness({ value, selectionEnd = value.length }: { value: string; selectionEnd?: number }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	useInputAreaAutosize({ inputRef: ref, inputValue: value, activeTabId: 'tab-1' });

	return (
		<textarea
			ref={(el) => {
				if (!el) return;
				Object.defineProperty(el, 'scrollHeight', { value: 200, configurable: true });
				Object.defineProperty(el, 'selectionEnd', { value: selectionEnd, configurable: true });
				ref.current = el;
			}}
			defaultValue={value}
			aria-label="input"
		/>
	);
}

describe('useInputAreaAutosize', () => {
	it('applies the external-sync height cap', async () => {
		const { getByLabelText } = render(<Harness value="hello" />);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('112px');
		});
	});

	it('scrolls to the end when caret is at the previous end', async () => {
		const { getByLabelText } = render(<Harness value="hello" />);

		await waitFor(() => {
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
		});
	});
});
