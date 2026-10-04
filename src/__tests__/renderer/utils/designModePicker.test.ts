/**
 * Tests for the Design Mode picker: the guest script (run in jsdom), the
 * parser for its console messages, and the payload assembler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DESIGN_MODE_ARM_SCRIPT,
	DESIGN_MODE_DISARM_SCRIPT,
	DESIGN_MODE_MAX_HTML_CHARS,
	DESIGN_MODE_MESSAGE_PREFIX,
	buildDesignModePrompt,
	designPickCaptureRect,
	filterDesignStyles,
	parseDesignModeMessage,
	type DesignModePick,
} from '../../../renderer/utils/designModePicker';

function makePick(overrides: Partial<DesignModePick> = {}): DesignModePick {
	return {
		url: 'https://example.com/app',
		tagName: 'button',
		selector: 'main > button.primary',
		html: '<button class="primary">Save</button>',
		htmlTruncated: false,
		styles: { display: 'inline-flex', color: 'rgb(255, 255, 255)' },
		rect: { x: 10, y: 20, width: 100, height: 40 },
		viewport: { width: 1280, height: 800 },
		...overrides,
	};
}

describe('parseDesignModeMessage', () => {
	it('ignores ordinary page logs and the other Maestro channels', () => {
		expect(parseDesignModeMessage('hello')).toBeNull();
		expect(parseDesignModeMessage('__MAESTRO_SCROLL__1')).toBeNull();
		expect(parseDesignModeMessage(undefined)).toBeNull();
		expect(parseDesignModeMessage(`${DESIGN_MODE_MESSAGE_PREFIX}{not json`)).toBeNull();
	});

	it('parses a cancel', () => {
		expect(parseDesignModeMessage(`${DESIGN_MODE_MESSAGE_PREFIX}{"type":"cancel"}`)).toEqual({
			type: 'cancel',
		});
	});

	it('parses a pick and keeps only the curated style properties', () => {
		const pick = { ...makePick(), styles: { color: 'red', 'evil-prop': 'x', display: 42 } };
		const event = parseDesignModeMessage(
			DESIGN_MODE_MESSAGE_PREFIX + JSON.stringify({ type: 'pick', pick })
		);
		expect(event?.type).toBe('pick');
		if (event?.type !== 'pick') return;
		expect(event.pick.styles).toEqual({ color: 'red' });
		expect(event.pick.selector).toBe('main > button.primary');
	});

	it('rejects a pick with a malformed rect', () => {
		const pick = { ...makePick(), rect: { x: 'a', y: 0, width: 1, height: 1 } };
		expect(
			parseDesignModeMessage(DESIGN_MODE_MESSAGE_PREFIX + JSON.stringify({ type: 'pick', pick }))
		).toBeNull();
	});

	it('caps an oversized html payload and marks it truncated', () => {
		const pick = { ...makePick(), html: 'x'.repeat(DESIGN_MODE_MAX_HTML_CHARS + 50) };
		const event = parseDesignModeMessage(
			DESIGN_MODE_MESSAGE_PREFIX + JSON.stringify({ type: 'pick', pick })
		);
		if (event?.type !== 'pick') throw new Error('expected a pick');
		expect(event.pick.html).toHaveLength(DESIGN_MODE_MAX_HTML_CHARS);
		expect(event.pick.htmlTruncated).toBe(true);
	});
});

describe('filterDesignStyles', () => {
	it('drops defaults, offsets on static elements, and border detail without a border', () => {
		const result = filterDesignStyles({
			display: 'flex',
			position: 'static',
			top: '10px',
			margin: '0px',
			'border-style': 'none',
			'border-width': '0px',
			'border-color': 'rgb(0, 0, 0)',
			'box-shadow': 'none',
			'background-color': 'rgba(0, 0, 0, 0)',
			color: 'rgb(17, 17, 17)',
		});
		expect(result).toEqual([
			['display', 'flex'],
			['color', 'rgb(17, 17, 17)'],
		]);
	});

	it('keeps offsets for positioned elements and border detail when bordered', () => {
		const result = Object.fromEntries(
			filterDesignStyles({
				position: 'absolute',
				top: '4px',
				'border-style': 'solid',
				'border-color': 'rgb(1, 2, 3)',
			})
		);
		expect(result).toMatchObject({
			position: 'absolute',
			top: '4px',
			'border-style': 'solid',
			'border-color': 'rgb(1, 2, 3)',
		});
	});
});

describe('designPickCaptureRect', () => {
	const webview = { left: 200, top: 100, width: 800, height: 600 };

	it('offsets the element by where the webview sits in the window', () => {
		expect(designPickCaptureRect(makePick(), webview)).toEqual({
			x: 210,
			y: 120,
			width: 100,
			height: 40,
		});
	});

	it('scales by the guest zoom factor', () => {
		expect(designPickCaptureRect(makePick(), webview, 2)).toEqual({
			x: 220,
			y: 140,
			width: 200,
			height: 80,
		});
	});

	it('clips to the visible webview area', () => {
		const pick = makePick({ rect: { x: -50, y: 580, width: 100, height: 100 } });
		expect(designPickCaptureRect(pick, webview)).toEqual({
			x: 200,
			y: 680,
			width: 50,
			height: 20,
		});
	});

	it('returns null when nothing of the element is on screen', () => {
		const pick = makePick({ rect: { x: 0, y: 900, width: 100, height: 40 } });
		expect(designPickCaptureRect(pick, webview)).toBeNull();
	});
});

describe('buildDesignModePrompt', () => {
	it('includes the url, selector, styles, and html', () => {
		const text = buildDesignModePrompt(makePick(), { hasScreenshot: true });
		expect(text).toContain('https://example.com/app');
		expect(text).toContain('Selector: `main > button.primary`');
		expect(text).toContain('- display: inline-flex');
		expect(text).toContain('```html\n<button class="primary">Save</button>\n```');
		expect(text).toContain('A screenshot of the element is attached.');
		expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
	});

	it('uses a longer fence when the html itself contains backticks', () => {
		const text = buildDesignModePrompt(makePick({ html: '<code>```js</code>' }), {
			hasScreenshot: false,
		});
		expect(text).toContain('````html\n<code>```js</code>\n````');
		expect(text).not.toContain('screenshot');
	});

	it('marks truncated html and partly offscreen screenshots', () => {
		const text = buildDesignModePrompt(
			makePick({ htmlTruncated: true, rect: { x: 0, y: 700, width: 100, height: 400 } }),
			{ hasScreenshot: true }
		);
		expect(text).toContain('<!-- truncated -->');
		expect(text).toContain('visible part of the element');
	});
});

describe('guest picker script', () => {
	let logs: string[];

	function designEvents() {
		return logs.map(parseDesignModeMessage).filter(Boolean);
	}

	beforeEach(() => {
		logs = [];
		vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
			logs.push(String(msg));
		});
		vi.useFakeTimers();
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
			setTimeout(() => cb(0), 16)
		);
		document.body.innerHTML = `
			<main id="app">
				<section class="card hero">
					<p>One</p>
					<p class="lead">Two <a href="#x">link</a></p>
				</section>
			</main>`;
	});

	afterEach(() => {
		new Function(DESIGN_MODE_DISARM_SCRIPT)();
		delete (window as unknown as Record<string, unknown>).__maestroDesignPicker;
		document.querySelectorAll('[data-maestro-design]').forEach((el) => el.remove());
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('reports the clicked element with a selector path and swallows the page click', () => {
		new Function(DESIGN_MODE_ARM_SCRIPT)();
		const lead = document.querySelector('p.lead') as HTMLElement;
		const pageClick = vi.fn();
		lead.addEventListener('click', pageClick);

		lead.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		lead.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		vi.advanceTimersByTime(100);

		expect(pageClick).not.toHaveBeenCalled();
		const [event] = designEvents();
		expect(event?.type).toBe('pick');
		if (event?.type !== 'pick') return;
		expect(event.pick.tagName).toBe('p');
		expect(event.pick.selector).toBe('main#app > section.card.hero > p.lead:nth-of-type(2)');
		expect(event.pick.html).toContain('<p class="lead">');
		expect(document.querySelector(event.pick.selector)).toBe(lead);
	});

	it('ArrowUp walks to the parent and Enter picks it', () => {
		new Function(DESIGN_MODE_ARM_SCRIPT)();
		const link = document.querySelector('a') as HTMLElement;
		link.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		vi.advanceTimersByTime(100);

		const [event] = designEvents();
		if (event?.type !== 'pick') throw new Error('expected a pick');
		expect(event.pick.tagName).toBe('p');
	});

	it('Escape cancels and leaves the page interactive', () => {
		new Function(DESIGN_MODE_ARM_SCRIPT)();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(designEvents()).toEqual([{ type: 'cancel' }]);

		const pageClick = vi.fn();
		document.querySelector('p')!.addEventListener('click', pageClick);
		document.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(pageClick).toHaveBeenCalled();
	});

	it('re-attaches its outline after the page re-renders it away', () => {
		new Function(DESIGN_MODE_ARM_SCRIPT)();
		document.querySelectorAll('[data-maestro-design]').forEach((el) => el.remove());
		document.querySelector('p')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		expect(document.querySelectorAll('[data-maestro-design]').length).toBe(2);
	});

	it('re-arming does not stack a second set of listeners', () => {
		new Function(DESIGN_MODE_ARM_SCRIPT)();
		new Function(DESIGN_MODE_ARM_SCRIPT)();
		const p = document.querySelector('p') as HTMLElement;
		p.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		vi.advanceTimersByTime(100);
		expect(designEvents()).toHaveLength(1);
	});
});
