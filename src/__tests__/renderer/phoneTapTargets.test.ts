/**
 * Pins the CSS half of the phone tap-target fixes in src/renderer/index.css.
 *
 * Each of these rules is paired with a JSX attribute (`data-tab-label`,
 * `data-tab-close`, `data-modal-resize-key`) and nothing in the type system
 * ties the two halves together: jsdom never applies index.css, so a renamed
 * or deleted rule passes every component test and only reappears on a phone as
 * a close button painted under the "+" cluster, or a modal whose top edge sits
 * inside the iOS status-bar band that swallows taps.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8');
const PHONE = String.raw`html\[data-runtime='web-desktop'\]\[data-bp='xs'\]`;

describe('phone tap-target rules', () => {
	it('pads the overlay of every resizable modal, not only <Modal>', () => {
		// Nine modals draw their own `fixed inset-0` overlay without the
		// `.modal-overlay` class; keying on the modal's parent covers them all.
		expect(css).toMatch(new RegExp(`${PHONE} :has\\(> \\[data-modal-resize-key\\]\\)`));
	});

	it('caps a tab chip and lets only its label shrink', () => {
		expect(css).toMatch(new RegExp(`${PHONE} \\[data-tab-id\\]\\s*\\{\\s*max-width:\\s*60vw;`));
		expect(css).toMatch(
			new RegExp(`${PHONE} \\[data-tab-label\\]\\s*\\{[^}]*text-overflow:\\s*ellipsis;`)
		);
	});

	it('grows the close x hit area on any coarse pointer', () => {
		expect(css).toMatch(/\[data-tab-close\]::before\s*\{[^}]*inset:\s*-8px;/);
	});
});
