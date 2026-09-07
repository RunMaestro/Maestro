#!/usr/bin/env node
/**
 * Generates the social preview card served at `/og.png`.
 *
 * A Maestro web-desktop URL is almost always shared in a chat app - iMessage,
 * Slack, Signal - and those clients render whatever Open Graph tags the page
 * declares. Without an `og:image` the card collapses to the page title over a
 * bare LAN address, which reads like a misconfigured router rather than an
 * invitation into someone's workspace.
 *
 * The output is COMMITTED (`src/web/public/og-image.png`), not built on demand.
 * Three reasons:
 *
 * 1. `canvas` is a devDependency and a native module. Generating at request time
 *    would drag it into the packaged app for one static image.
 * 2. The card says nothing that changes at runtime. It is a brand mark.
 * 3. A preview crawler gives a page a short budget. Serving bytes already on
 *    disk cannot miss it.
 *
 * Run `npm run gen:og-image` after changing the brand mark or the card copy,
 * then commit the PNG alongside this file.
 *
 * FONT NOTE: the wordmark uses the same stack as `WORDMARK_FONT_STACK` in
 * `src/shared/fontStack.ts`, resolved once here at generation time and baked
 * into the pixels. Whichever face the generating machine has installed is the
 * one that ships, so the script prints its choice - if that line does not say
 * JetBrains Mono, the regenerated card will not match the app's splash.
 */

import { createCanvas, loadImage, registerFont } from 'canvas';
import { writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ICON_PATH = path.join(REPO_ROOT, 'src/web/public/icons/icon-512x512.png');
const OUT_PATH = path.join(REPO_ROOT, 'src/web/public/og-image.png');

// 1200x630 is the size every major crawler crops toward, so producing it
// directly means nothing downstream has to guess at a crop.
const WIDTH = 1200;
const HEIGHT = 630;

// Sampled from the app icon rather than restated, so the tile and the glow
// behind it cannot drift apart from the mark itself.
const BRAND_PURPLE = '#8823f7';
const GLOW_RGB = '145, 70, 255'; // Pedurple #9146FF, kept as parts so alpha varies
const BACKDROP = '#0a0a0a';
const WORDMARK_COLOR = '#f5f5f5';
const SUBTITLE_COLOR = '#9b9b9b';

const WORDMARK = 'MAESTRO';
const SUBTITLE = 'Your agent workspace, in the browser.';

// Mirrors WORDMARK_FONT_STACK. The brand mark never follows a reading font.
const WORDMARK_FONTS = ['JetBrains Mono', 'Fira Code', 'Menlo', 'Courier New', 'monospace'];
const SUBTITLE_FONTS = ['Inter', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'];

/**
 * Pick the first family the renderer actually has.
 *
 * node-canvas silently substitutes an unknown family, and its substitute for a
 * missing monospace face is proportional - which turns a tracked-out wordmark
 * into ragged text. Measuring a fixed-pitch probe is the only way to tell a
 * real resolution from a fallback: in a monospace face `M` and `i` are the same
 * width, and in every substitute they are not.
 */
function resolveFont(ctx, families, { requireFixedPitch }) {
	for (const family of families) {
		ctx.font = `700 40px "${family}"`;
		const wide = ctx.measureText('M').width;
		const narrow = ctx.measureText('i').width;
		if (!requireFixedPitch) return family;
		if (wide > 0 && Math.abs(wide - narrow) < 0.5) return family;
	}
	return families[families.length - 1];
}

/**
 * Draw text with explicit tracking.
 *
 * The wordmark is set at 0.35em, and node-canvas has no `letterSpacing`, so the
 * glyphs are placed one at a time. The trailing gap after the last letter is
 * dropped from the measured width, otherwise the mark centers slightly left of
 * true - visible at this size against a symmetric glow.
 */
function drawTrackedText(ctx, text, centerX, baselineY, trackingPx) {
	const glyphs = [...text];
	const total =
		glyphs.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) +
		trackingPx * (glyphs.length - 1);

	let x = centerX - total / 2;
	for (const ch of glyphs) {
		ctx.fillText(ch, x, baselineY);
		x += ctx.measureText(ch).width + trackingPx;
	}
	return total;
}

/** The accent purple at a given alpha. One source, so the glows cannot drift. */
function glow(alpha) {
	return `rgba(${GLOW_RGB}, ${alpha})`;
}

/** Rounded-rect path, used for the icon tile and its clip. */
function roundedRectPath(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

async function main() {
	if (!existsSync(ICON_PATH)) {
		console.error(`Icon not found at ${ICON_PATH}. Nothing to build the card from.`);
		process.exit(1);
	}

	// Registering the app's own font when it happens to be installed keeps the
	// wordmark identical to the splash. Absent, the stack below still resolves.
	for (const candidate of [
		'/Library/Fonts/JetBrainsMono-Bold.ttf',
		`${process.env.HOME}/Library/Fonts/JetBrainsMono-Bold.ttf`,
	]) {
		if (existsSync(candidate)) {
			registerFont(candidate, { family: 'JetBrains Mono', weight: '700' });
			break;
		}
	}

	const canvas = createCanvas(WIDTH, HEIGHT);
	const ctx = canvas.getContext('2d');

	// Backdrop: the same near-black the web-desktop paints before React mounts,
	// so the card and the page it opens are recognisably the same product.
	ctx.fillStyle = BACKDROP;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);

	// Two stacked radial glows behind the mark. One tight and bright to make the
	// tile feel lit rather than pasted on, one wide and faint so the corners fall
	// away instead of ending at a visible edge.
	const glowCenterY = HEIGHT * 0.36;
	const wide = ctx.createRadialGradient(WIDTH / 2, glowCenterY, 0, WIDTH / 2, glowCenterY, 640);
	wide.addColorStop(0, glow(0.3));
	wide.addColorStop(0.55, glow(0.07));
	wide.addColorStop(1, glow(0));
	ctx.fillStyle = wide;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);

	const tight = ctx.createRadialGradient(WIDTH / 2, glowCenterY, 0, WIDTH / 2, glowCenterY, 250);
	tight.addColorStop(0, glow(0.34));
	tight.addColorStop(1, glow(0));
	ctx.fillStyle = tight;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);

	// Icon tile. The source PNG already carries the purple field and the rounded
	// corners; it is re-clipped here only so the radius matches at this size.
	const icon = await loadImage(ICON_PATH);
	const tile = 168;
	const tileX = (WIDTH - tile) / 2;
	const tileY = glowCenterY - tile / 2;
	const tileRadius = tile * 0.235;

	ctx.save();
	ctx.shadowColor = 'rgba(136, 35, 247, 0.55)';
	ctx.shadowBlur = 60;
	ctx.shadowOffsetY = 12;
	ctx.fillStyle = BRAND_PURPLE;
	roundedRectPath(ctx, tileX, tileY, tile, tile, tileRadius);
	ctx.fill();
	ctx.restore();

	ctx.save();
	roundedRectPath(ctx, tileX, tileY, tile, tile, tileRadius);
	ctx.clip();
	ctx.drawImage(icon, tileX, tileY, tile, tile);
	ctx.restore();

	// Wordmark.
	const wordmarkFont = resolveFont(ctx, WORDMARK_FONTS, { requireFixedPitch: true });
	const wordmarkSize = 82;
	ctx.font = `700 ${wordmarkSize}px "${wordmarkFont}"`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = WORDMARK_COLOR;
	drawTrackedText(ctx, WORDMARK, WIDTH / 2, HEIGHT * 0.685, wordmarkSize * 0.35);

	// Subtitle. Slightly tracked so it reads as a companion to the wordmark
	// rather than as body copy that wandered onto a logo.
	const subtitleFont = resolveFont(ctx, SUBTITLE_FONTS, { requireFixedPitch: false });
	const subtitleSize = 27;
	ctx.font = `400 ${subtitleSize}px "${subtitleFont}"`;
	ctx.fillStyle = SUBTITLE_COLOR;
	drawTrackedText(ctx, SUBTITLE, WIDTH / 2, HEIGHT * 0.795, 0.6);

	// Accent rule under the whole composition. Fades out at both ends so it
	// reads as light rather than as a border the card is missing three sides of.
	const rule = ctx.createLinearGradient(WIDTH * 0.3, 0, WIDTH * 0.7, 0);
	rule.addColorStop(0, glow(0));
	rule.addColorStop(0.5, glow(0.75));
	rule.addColorStop(1, glow(0));
	ctx.fillStyle = rule;
	ctx.fillRect(WIDTH * 0.3, HEIGHT * 0.875, WIDTH * 0.4, 2);

	const png = canvas.toBuffer('image/png');
	writeFileSync(OUT_PATH, png);

	const kb = (png.length / 1024).toFixed(1);
	console.log(`Wrote ${path.relative(REPO_ROOT, OUT_PATH)} (${WIDTH}x${HEIGHT}, ${kb} KB)`);
	console.log(`  wordmark font: ${wordmarkFont}`);
	console.log(`  subtitle font: ${subtitleFont}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
