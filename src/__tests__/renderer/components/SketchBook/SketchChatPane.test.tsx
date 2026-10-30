/**
 * The Sketch chat pane renders every message as chat markdown, the same
 * renderer the AI Terminal uses. A guest's text comes from outside this
 * computer, so its images stay placeholders: loading one would tell the guest
 * this computer's address, or read a local file on their say-so.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SketchChatPane } from '../../../../renderer/components/SketchBook/SketchChatPane';
import type { SketchChatMessage } from '../../../../renderer/stores/sketchSessionStore';
import { mockTheme } from '../../../helpers/mockTheme';

const agentMessage: SketchChatMessage = {
	id: 'chat-a',
	actor: { id: 'agent:a1', kind: 'bot', name: 'Scratch', role: 'conductor' },
	text: 'I drew a silverback.\n\n**What changed:**\n- **Face:** a heavy brow\n- **Look:** fur strokes',
	ts: 1,
};

function guestMessage(text: string): SketchChatMessage {
	return {
		id: 'chat-g',
		actor: { id: 'g1', kind: 'guest', name: 'Marco', role: 'rw' },
		text,
		ts: 2,
	};
}

describe('SketchChatPane markdown', () => {
	it('renders bold and lists instead of their raw syntax', () => {
		const { container } = render(<SketchChatPane messages={[agentMessage]} theme={mockTheme} />);
		expect(screen.getByText('What changed:').tagName).toBe('STRONG');
		expect(container.querySelectorAll('li')).toHaveLength(2);
		expect(container.textContent).not.toContain('**');
	});

	it('loads an image the agent posts', () => {
		const { container } = render(
			<SketchChatPane
				messages={[{ ...agentMessage, text: '![gorilla](https://example.com/g.png)' }]}
				theme={mockTheme}
			/>
		);
		expect(container.querySelector('img[src="https://example.com/g.png"]')).not.toBeNull();
	});

	it("keeps a guest's remote image a placeholder", () => {
		const { container } = render(
			<SketchChatPane
				messages={[guestMessage('look ![pixel](https://tracker.example/p.png)')]}
				theme={mockTheme}
			/>
		);
		expect(container.querySelector('img')).toBeNull();
		expect(screen.getByText('Image not loaded: pixel')).toBeTruthy();
	});

	it("keeps a guest's raw HTML image a placeholder", () => {
		const { container } = render(
			<SketchChatPane
				messages={[guestMessage('<img src="https://tracker.example/p.png">')]}
				theme={mockTheme}
			/>
		);
		expect(container.querySelector('img')).toBeNull();
		expect(screen.getByText('Image not loaded')).toBeTruthy();
	});

	it('still renders the rest of a guest message as markdown', () => {
		render(<SketchChatPane messages={[guestMessage('make it **bigger**')]} theme={mockTheme} />);
		expect(screen.getByText('bigger').tagName).toBe('STRONG');
	});
});
