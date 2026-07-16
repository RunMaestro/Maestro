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

	beforeEach(() => {
		clearConcertoDesignerFramesForTests();
		frame = document.createElement('iframe');
		document.body.appendChild(frame);
		vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
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
		Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 640 });
		Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 480 });
		registerConcertoDesignerFrame('movement', 'mockup', 3, frame);
	});

	afterEach(() => {
		clearConcertoDesignerFramesForTests();
		frame.remove();
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
});
