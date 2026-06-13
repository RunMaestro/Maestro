import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { InlineCode } from '../../../../renderer/components/Markdown/components/InlineCode';

// flashCopiedToClipboard + clipboard are invoked on click; stub clipboard so the
// copy handler resolves without touching the real navigator API.
vi.mock('../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));

import { safeClipboardWrite } from '../../../../renderer/utils/clipboard';

describe('InlineCode', () => {
	it('renders a hex swatch before hex-color content', () => {
		const { container } = render(<InlineCode>#FF0000</InlineCode>);
		const code = container.querySelector('code')!;
		const swatch = code.querySelector('span');
		expect(swatch).toBeInTheDocument();
		expect(swatch!.getAttribute('style')).toContain('background-color');
		expect(code.textContent).toContain('#FF0000');
	});

	it('renders no swatch for non-hex content', () => {
		const { container } = render(<InlineCode>npm run dev</InlineCode>);
		const code = container.querySelector('code')!;
		expect(code.querySelector('span')).toBeNull();
		expect(code.textContent).toBe('npm run dev');
	});

	it('is keyboard- and click-copyable', async () => {
		const { container } = render(<InlineCode>copy me</InlineCode>);
		const code = container.querySelector('code')!;
		expect(code.getAttribute('role')).toBe('button');
		fireEvent.click(code);
		expect(safeClipboardWrite).toHaveBeenCalledWith('copy me');
	});

	it('forwards className and passthrough props, and keeps the pointer cursor', () => {
		const { container } = render(
			<InlineCode className="custom" passthrough={{ 'data-x': 'y' }} style={{ color: 'red' }}>
				code
			</InlineCode>
		);
		const code = container.querySelector('code')!;
		expect(code.className).toBe('custom');
		expect(code.getAttribute('data-x')).toBe('y');
		expect(code.style.cursor).toBe('pointer');
		expect(code.style.color).toBe('red');
	});
});
