import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONCERTO_DESIGNER_CHANNEL } from '../../../../shared/concerto-html';
import {
	clearConcertoDesignerFramesForTests,
	getConcertoDesignerFrameSnapshot,
	handleConcertoDesignerMessage,
	interactWithConcertoDesignerFrame,
	registerConcertoDesignerFrame,
} from '../../../../renderer/components/Concerto/concertoDesignerBridge';

describe('concertoDesignerBridge', () => {
	let frame: HTMLIFrameElement;
	const extraFrames: HTMLIFrameElement[] = [];

	function createConnectedFrame(): HTMLIFrameElement {
		const connectedFrame = document.createElement('iframe');
		document.body.appendChild(connectedFrame);
		vi.spyOn(connectedFrame, 'getBoundingClientRect').mockReturnValue({
			x: 20,
			y: 40,
			width: 640,
			height: 480,
			top: 40,
			right: 660,
			bottom: 520,
			left: 20,
			toJSON: () => ({}),
		});
		Object.defineProperty(connectedFrame, 'clientWidth', { configurable: true, value: 640 });
		Object.defineProperty(connectedFrame, 'clientHeight', { configurable: true, value: 480 });
		return connectedFrame;
	}

	beforeEach(() => {
		clearConcertoDesignerFramesForTests();
		frame = createConnectedFrame();
		registerConcertoDesignerFrame('movement', 'mockup', 3, frame);
	});

	afterEach(() => {
		clearConcertoDesignerFramesForTests();
		frame.remove();
		for (const extraFrame of extraFrames.splice(0)) extraFrame.remove();
		vi.restoreAllMocks();
	});

	it('reports the live crop, readiness, and bounded runtime diagnostics', async () => {
		handleConcertoDesignerMessage('movement', 'mockup', {
			source: frame.contentWindow,
			data: { channel: CONCERTO_DESIGNER_CHANNEL, kind: 'ready' },
		} as MessageEvent);
		handleConcertoDesignerMessage('movement', 'mockup', {
			source: frame.contentWindow,
			data: {
				channel: CONCERTO_DESIGNER_CHANNEL,
				kind: 'console',
				level: 'warn',
				message: 'Contrast needs attention',
				timestamp: 123,
			},
		} as MessageEvent);

		await expect(getConcertoDesignerFrameSnapshot('movement', 'mockup')).resolves.toEqual({
			id: 'mockup',
			ready: true,
			revision: 3,
			rect: { x: 20, y: 40, width: 640, height: 480 },
			viewport: { width: 640, height: 480 },
			logs: [
				{
					level: 'warn',
					message: 'Contrast needs attention',
					timestamp: 123,
					line: undefined,
					column: undefined,
				},
			],
		});
	});

	it('round-trips selector-scoped interaction results with the sandbox frame', async () => {
		handleConcertoDesignerMessage('movement', 'mockup', {
			source: frame.contentWindow,
			data: { channel: CONCERTO_DESIGNER_CHANNEL, kind: 'ready' },
		} as MessageEvent);
		const postMessage = vi
			.spyOn(frame.contentWindow!, 'postMessage')
			.mockImplementation((message: unknown) => {
				const command = message as { requestId: string; action: string; selector: string };
				queueMicrotask(() =>
					handleConcertoDesignerMessage('movement', 'mockup', {
						source: frame.contentWindow,
						data: {
							channel: CONCERTO_DESIGNER_CHANNEL,
							kind: 'command-result',
							requestId: command.requestId,
							ok: true,
							action: command.action,
							selector: command.selector,
							message: 'Clicked element',
							element: { tag: 'button', text: 'Continue', ariaLabel: 'Continue' },
						},
					} as MessageEvent)
				);
			});

		await expect(
			interactWithConcertoDesignerFrame('movement', 'mockup', {
				kind: 'click',
				selector: '#continue',
			})
		).resolves.toMatchObject({
			ok: true,
			action: 'click',
			selector: '#continue',
			message: 'Clicked element',
		});
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: CONCERTO_DESIGNER_CHANNEL,
				kind: 'command',
				action: 'click',
				selector: '#continue',
			}),
			'*'
		);
	});

	it('waits for the requested ready revision and ignores a stale replacement', async () => {
		const snapshotPromise = getConcertoDesignerFrameSnapshot('movement', 'mockup', 1000, 5);
		const staleFrame = createConnectedFrame();
		extraFrames.push(staleFrame);
		registerConcertoDesignerFrame('movement', 'mockup', 4, staleFrame);
		handleConcertoDesignerMessage('movement', 'mockup', {
			source: staleFrame.contentWindow,
			data: { channel: CONCERTO_DESIGNER_CHANNEL, kind: 'ready' },
		} as MessageEvent);

		const pendingMarker = Symbol('pending');
		await expect(Promise.race([snapshotPromise, Promise.resolve(pendingMarker)])).resolves.toBe(
			pendingMarker
		);

		const currentFrame = createConnectedFrame();
		extraFrames.push(currentFrame);
		registerConcertoDesignerFrame('movement', 'mockup', 5, currentFrame);
		handleConcertoDesignerMessage('movement', 'mockup', {
			source: currentFrame.contentWindow,
			data: { channel: CONCERTO_DESIGNER_CHANNEL, kind: 'ready' },
		} as MessageEvent);

		await expect(snapshotPromise).resolves.toMatchObject({ revision: 5, ready: true });
	});

	it('does not dispatch an action to an older ready revision', async () => {
		handleConcertoDesignerMessage('movement', 'mockup', {
			source: frame.contentWindow,
			data: { channel: CONCERTO_DESIGNER_CHANNEL, kind: 'ready' },
		} as MessageEvent);
		const stalePostMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
		const action = { kind: 'click' as const, selector: '#continue' };
		const actionPromise = interactWithConcertoDesignerFrame('movement', 'mockup', action, 1000, 4);
		await Promise.resolve();
		expect(stalePostMessage).not.toHaveBeenCalled();

		const currentFrame = createConnectedFrame();
		extraFrames.push(currentFrame);
		const currentPostMessage = vi
			.spyOn(currentFrame.contentWindow!, 'postMessage')
			.mockImplementation((message: unknown) => {
				const command = message as { requestId: string };
				queueMicrotask(() =>
					handleConcertoDesignerMessage('movement', 'mockup', {
						source: currentFrame.contentWindow,
						data: {
							channel: CONCERTO_DESIGNER_CHANNEL,
							kind: 'command-result',
							requestId: command.requestId,
							ok: true,
							action: 'click',
							selector: '#continue',
							message: 'Clicked element',
						},
					} as MessageEvent)
				);
			});
		registerConcertoDesignerFrame('movement', 'mockup', 4, currentFrame);
		handleConcertoDesignerMessage('movement', 'mockup', {
			source: currentFrame.contentWindow,
			data: { channel: CONCERTO_DESIGNER_CHANNEL, kind: 'ready' },
		} as MessageEvent);

		await expect(actionPromise).resolves.toMatchObject({ ok: true, action: 'click' });
		expect(currentPostMessage).toHaveBeenCalledTimes(1);
	});
});
