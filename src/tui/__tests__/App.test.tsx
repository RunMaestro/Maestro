import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../App';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('App', () => {
	it('shows the resolved data directory and the quit hint', () => {
		const { lastFrame, unmount } = render(<App userDataDir="/tmp/maestro-data" />);
		expect(lastFrame()).toContain('Maestro TUI');
		expect(lastFrame()).toContain('Data directory: /tmp/maestro-data');
		expect(lastFrame()).toContain('Press q to quit');
		unmount();
	});

	it('exits on q', async () => {
		const { stdin, lastFrame, unmount } = render(<App userDataDir="/tmp/maestro-data" />);
		const before = lastFrame();
		stdin.write('q');
		await tick();
		// Ink leaves the last frame on screen after exit; a second keypress must be inert.
		expect(lastFrame()).toBe(before);
		unmount();
	});
});
