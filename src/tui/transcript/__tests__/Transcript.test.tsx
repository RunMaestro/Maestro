import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Transcript } from '../Transcript';
import { TranscriptViewport } from '../TranscriptViewport';
import { entry, toolEntry } from './fixtures';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Transcript (scrollback)', () => {
	// ink-testing-library renders in Ink's debug mode, where every frame is the static output so far
	// plus the live tree. So "Static is used" is shown by its defining behavior: an entry already
	// printed is never rendered again, even if the entry it came from changes.
	it('prints finished entries once through <Static> and keeps only the live tail dynamic', async () => {
		const first = entry('user', 'FIRSTMESSAGE');
		const reply = entry('ai', 'REPLYMESSAGE');
		const running = toolEntry('Bash', { command: 'npm test' }, { status: 'running' });

		const { lastFrame, rerender, unmount } = render(
			<Transcript entries={[first, reply, running]} width={60} expandTools={false} />
		);
		await tick();
		expect(lastFrame()).toContain('FIRSTMESSAGE');
		expect(lastFrame()).toContain('REPLYMESSAGE');
		expect(lastFrame()).toContain('… Ran npm test');

		// The call finishes, a message arrives, and the first message's text is edited in place.
		const done = toolEntry('Bash', { command: 'npm test' }, { status: 'completed' });
		done.id = running.id;
		rerender(
			<Transcript
				entries={[{ ...first, text: 'EDITEDMESSAGE' }, reply, done, entry('ai', 'NEXTMESSAGE')]}
				width={60}
				expandTools={false}
			/>
		);
		await tick();

		const frame = lastFrame() ?? '';
		// Static never re-renders a printed entry, so the edit does not show.
		expect(frame).toContain('FIRSTMESSAGE');
		expect(frame).not.toContain('EDITEDMESSAGE');
		expect(frame.split('REPLYMESSAGE')).toHaveLength(2);
		// New finished entries are printed after it, and the finished call replaces the running one.
		expect(frame).toContain('NEXTMESSAGE');
		expect(frame).toContain('✓ Ran npm test');
		expect(frame).not.toContain('… Ran npm test');
		unmount();
	});

	it('renders a running tool call outside <Static>, so it can still change', async () => {
		const running = toolEntry('Bash', { command: 'npm test' }, { status: 'running' });
		const { lastFrame, rerender, unmount } = render(
			<Transcript entries={[running]} width={60} expandTools={false} />
		);
		await tick();
		expect(lastFrame()).toContain('… Ran npm test');

		const failed = toolEntry('Bash', { command: 'npm test' }, { status: 'failed' });
		failed.id = running.id;
		rerender(<Transcript entries={[failed]} width={60} expandTools={false} />);
		await tick();
		expect(lastFrame()).toContain('✗ Ran npm test');
		expect(lastFrame()).not.toContain('… Ran npm test');
		unmount();
	});
});

describe('TranscriptViewport', () => {
	const many = Array.from({ length: 40 }, (_, index) => entry('ai', `message number ${index}`));

	it('shows the newest entries and clips the oldest to the pane height', async () => {
		const { lastFrame, unmount } = render(
			<TranscriptViewport entries={many} width={50} height={10} expandTools={false} />
		);
		await tick();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('message number 39');
		expect(frame).not.toContain('message number 0');
		expect(frame.split('\n').length).toBeLessThanOrEqual(10);
		unmount();
	});

	it('mounts only as many trailing entries as can fill the pane', async () => {
		const { lastFrame, unmount } = render(
			<TranscriptViewport entries={many} width={50} height={10} expandTools={false} />
		);
		await tick();
		// Entry 20 is far outside the window; it is not rendered at all.
		expect(lastFrame()).not.toContain('message number 20');
		unmount();
	});

	it('shows a tool call as one line, and its detail when expanded', async () => {
		const call = toolEntry('Bash', { command: 'ls -la' }, { status: 'completed' }, 'OUTPUTLINE');
		const collapsed = render(
			<TranscriptViewport entries={[call]} width={60} height={12} expandTools={false} />
		);
		await tick();
		expect(collapsed.lastFrame()).toContain('▸ ✓');
		expect(collapsed.lastFrame()).not.toContain('OUTPUTLINE');
		collapsed.unmount();

		const expanded = render(
			<TranscriptViewport entries={[call]} width={60} height={12} expandTools={true} />
		);
		await tick();
		expect(expanded.lastFrame()).toContain('▾ ✓');
		expect(expanded.lastFrame()).toContain('OUTPUTLINE');
		expanded.unmount();
	});

	it('renders markdown in user messages and shows the sender and time', async () => {
		const { lastFrame, unmount } = render(
			<TranscriptViewport
				entries={[entry('user', 'run **this** please\n\n- one\n- two')]}
				width={60}
				height={12}
				expandTools={false}
			/>
		);
		await tick();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('You');
		expect(frame).toContain('run this please');
		expect(frame).not.toContain('**');
		expect(frame).toContain('• one');
		unmount();
	});
});
