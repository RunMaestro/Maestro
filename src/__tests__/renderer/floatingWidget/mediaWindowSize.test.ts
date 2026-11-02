/**
 * Tests for the media window's sizing rule: the size each kind wants, and when
 * the widget may set it without overwriting a size the user chose.
 */
import { describe, expect, it } from 'vitest';

import {
	MEDIA_LIST_CLEARANCE,
	MEDIA_WINDOW_FRAME_BORDER,
	MEDIA_WINDOW_STRIP_HEIGHT,
	mediaListOverflowNeed,
	mediaWindowBaselineAfter,
	mediaWindowSizeFor,
	planMediaWindowSize,
	sameMediaWindowSize,
	sanitizeMediaWindowBaseline,
	type MediaWindowBaseline,
} from '../../../renderer/floatingWidget/mediaWindowSize';
import { MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT } from '../../../renderer/utils/mediaFloatGeometry';

const BORDERS = 2 * MEDIA_WINDOW_FRAME_BORDER;

describe('mediaWindowSizeFor', () => {
	it('sizes audio to the strip plus the measured transport', () => {
		expect(mediaWindowSizeFor({ kind: 'audio', transportHeight: 60 })).toEqual({
			width: 420,
			height: MEDIA_WINDOW_STRIP_HEIGHT + 60 + BORDERS,
		});
	});

	it('ignores an aspect for audio', () => {
		expect(mediaWindowSizeFor({ kind: 'audio', aspect: 1, transportHeight: 60 })).toEqual(
			mediaWindowSizeFor({ kind: 'audio', transportHeight: 60 })
		);
	});

	it('uses the transport fallback before the first measurement', () => {
		expect(mediaWindowSizeFor({ kind: 'audio', transportHeight: null }).height).toBe(
			MEDIA_WINDOW_STRIP_HEIGHT + MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT + BORDERS
		);
	});

	it('sizes video to the strip, the picture at its aspect, and the transport', () => {
		const stage = 480 - BORDERS;
		expect(mediaWindowSizeFor({ kind: 'video', aspect: 4 / 3, transportHeight: 60 })).toEqual({
			width: 480,
			height: MEDIA_WINDOW_STRIP_HEIGHT + 60 + BORDERS + Math.round(stage / (4 / 3)),
		});
	});

	it('assumes 16:9 until the video says otherwise', () => {
		expect(mediaWindowSizeFor({ kind: 'video', transportHeight: 60 })).toEqual(
			mediaWindowSizeFor({ kind: 'video', aspect: 16 / 9, transportHeight: 60 })
		);
	});
});

describe('sameMediaWindowSize', () => {
	it('treats a pixel or two of drift as the same size', () => {
		expect(sameMediaWindowSize({ width: 420, height: 94 }, { width: 421, height: 92 })).toBe(true);
		expect(sameMediaWindowSize({ width: 420, height: 94 }, { width: 430, height: 94 })).toBe(false);
	});
});

describe('planMediaWindowSize', () => {
	const audio = { kind: 'audio' as const, transportHeight: 60 };
	const video = { kind: 'video' as const, aspect: 16 / 9, transportHeight: 60 };
	const audioSize = mediaWindowSizeFor(audio);
	const videoSize = mediaWindowSizeFor(video);
	const audioBaseline = mediaWindowBaselineAfter('audio', audioSize, audioSize);

	it('waits while the window has no bounds', () => {
		expect(planMediaWindowSize(audio, null, null)).toEqual({ apply: null, baseline: null });
	});

	it('sizes a window it never sized', () => {
		const plan = planMediaWindowSize(video, { width: 420, height: 96 }, null);
		expect(plan.apply).toEqual(videoSize);
	});

	it('resizes on a kind change when the user left the size alone', () => {
		const plan = planMediaWindowSize(video, audioSize, audioBaseline);
		expect(plan.apply).toEqual(videoSize);
	});

	it('keeps the user size on a kind change after a resize, and makes it the baseline', () => {
		const dragged = { width: 600, height: 300 };
		const plan = planMediaWindowSize(video, dragged, audioBaseline);
		expect(plan.apply).toBeNull();
		expect(plan.baseline).toEqual({ kind: 'video', requested: dragged, actual: dragged });

		// The next kind change, with no drag in between, sizes the window again.
		const next = planMediaWindowSize(audio, dragged, plan.baseline);
		expect(next.apply).toEqual(audioSize);
	});

	it('does nothing when the same kind wants the size it already set', () => {
		expect(planMediaWindowSize(audio, audioSize, audioBaseline)).toEqual({
			apply: null,
			baseline: audioBaseline,
		});
	});

	it('follows a late aspect or transport measurement within the same kind', () => {
		const videoBaseline = mediaWindowBaselineAfter('video', videoSize, videoSize);
		const square = { ...video, aspect: 1 };
		expect(planMediaWindowSize(square, videoSize, videoBaseline).apply).toEqual(
			mediaWindowSizeFor(square)
		);

		const remeasured = { ...audio, transportHeight: 72 };
		expect(planMediaWindowSize(remeasured, audioSize, audioBaseline).apply).toEqual(
			mediaWindowSizeFor(remeasured)
		);
	});

	it('leaves a user-resized window alone within the same kind', () => {
		const plan = planMediaWindowSize(
			{ ...audio, transportHeight: 72 },
			{ width: 700, height: audioSize.height },
			audioBaseline
		);
		expect(plan.apply).toBeNull();
		expect(plan.baseline).toBe(audioBaseline);
	});

	it('compares against the size the window took, not the size it was asked for', () => {
		// Main raised the request to the window minimum; that is not a user resize.
		const clamped = { width: 420, height: 120 };
		const baseline = mediaWindowBaselineAfter('audio', audioSize, clamped);
		expect(planMediaWindowSize(video, clamped, baseline).apply).toEqual(videoSize);
		// And the same request is not re-sent just because the window differs from it.
		expect(planMediaWindowSize(audio, clamped, baseline).apply).toBeNull();
	});
});

describe('mediaWindowBaselineAfter', () => {
	it('falls back to the requested size when the window reported none', () => {
		const size = { width: 420, height: 94 };
		expect(mediaWindowBaselineAfter('audio', size, null)).toEqual({
			kind: 'audio',
			requested: size,
			actual: size,
		});
	});
});

describe('sanitizeMediaWindowBaseline', () => {
	const valid: MediaWindowBaseline = {
		kind: 'video',
		requested: { width: 480, height: 360 },
		actual: { width: 480, height: 358 },
	};

	it('keeps a well-formed baseline', () => {
		expect(sanitizeMediaWindowBaseline(valid)).toEqual(valid);
	});

	it.each([
		['null', null],
		['a string', 'video'],
		['an unknown kind', { ...valid, kind: 'image' }],
		['a missing size', { kind: 'audio', requested: valid.requested }],
		['a zero width', { ...valid, actual: { width: 0, height: 10 } }],
		['a non-finite height', { ...valid, requested: { width: 10, height: Infinity } }],
	])('rejects %s', (_label, value) => {
		expect(sanitizeMediaWindowBaseline(value)).toBeNull();
	});
});

describe('mediaListOverflowNeed', () => {
	// An audio card 96px tall with its list button 4-28px down the title strip.
	const card = { top: 0, bottom: 96 };
	const anchor = { top: 4, bottom: 28 };

	it('asks each side for the list plus its clearance, less the space already there', () => {
		expect(mediaListOverflowNeed(card, anchor, 300)).toEqual({
			above: 300 + MEDIA_LIST_CLEARANCE - 4,
			below: 300 + MEDIA_LIST_CLEARANCE - 68,
		});
	});

	it('asks for nothing below when the card is tall enough (a video)', () => {
		expect(mediaListOverflowNeed({ top: 0, bottom: 400 }, anchor, 300).below).toBe(0);
	});

	it('measures against the card, so room already borrowed does not change the answer', () => {
		const shifted = mediaListOverflowNeed(
			{ top: 300, bottom: 396 },
			{ top: 304, bottom: 328 },
			300
		);
		expect(shifted).toEqual(mediaListOverflowNeed(card, anchor, 300));
	});

	it('rounds fractional layout up', () => {
		expect(mediaListOverflowNeed(card, { top: 4.4, bottom: 28.4 }, 100.2).below).toBe(
			Math.ceil(100.2 + MEDIA_LIST_CLEARANCE - (96 - 28.4))
		);
	});
});
