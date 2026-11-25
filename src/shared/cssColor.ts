/**
 * Deterministic CSS color validation.
 *
 * Theme-import validation previously relied on a DOM round-trip
 * (`new Option().style.color = value`), which is non-deterministic: jsdom's CSS
 * parser behaves differently than Chromium, and in tests it is corrupted when
 * a sibling test spies on `document.createElement` (the round-trip then rejects
 * every color). This pure validator behaves identically everywhere -
 * production, local tests, and CI - with no DOM dependency.
 *
 * Supported forms: hex (#RGB, #RGBA, #RRGGBB, #RRGGBBAA), rgb()/rgba(),
 * hsl()/hsla(), and CSS named colors (CSS Color Module Level 4).
 *
 * Two checks with two jobs. `isValidCssColor()` asks "does this look like a
 * color" for input a person typed (it trims, and it is loose inside a color
 * function). `isStrictCssColor()` asks "can this be written RAW into CSS text"
 * for a value someone else supplied, such as a plugin theme color that ends up
 * in a `<style>` block: an exact grammar with nothing around it.
 */

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// Functional notations: rgb(), rgba(), hsl(), hsla(). Permissive on the inner
// arguments (numbers, %, commas, slashes, whitespace) - we only need to
// distinguish "looks like a color" from arbitrary strings like "not-a-color".
const RGB_COLOR = /^rgba?\(\s*[0-9.,%\s/]+\)$/i;
const HSL_COLOR = /^hsla?\(\s*[0-9.,%\s/deg]+\)$/i;

/**
 * CSS named colors (CSS Color Module Level 4), plus `transparent` and
 * `currentcolor`. Used to validate named values without a DOM round-trip.
 */
const CSS_NAMED_COLORS = new Set<string>([
	'transparent',
	'currentcolor',
	'aliceblue',
	'antiquewhite',
	'aqua',
	'aquamarine',
	'azure',
	'beige',
	'bisque',
	'black',
	'blanchedalmond',
	'blue',
	'blueviolet',
	'brown',
	'burlywood',
	'cadetblue',
	'chartreuse',
	'chocolate',
	'coral',
	'cornflowerblue',
	'cornsilk',
	'crimson',
	'cyan',
	'darkblue',
	'darkcyan',
	'darkgoldenrod',
	'darkgray',
	'darkgreen',
	'darkgrey',
	'darkkhaki',
	'darkmagenta',
	'darkolivegreen',
	'darkorange',
	'darkorchid',
	'darkred',
	'darksalmon',
	'darkseagreen',
	'darkslateblue',
	'darkslategray',
	'darkslategrey',
	'darkturquoise',
	'darkviolet',
	'deeppink',
	'deepskyblue',
	'dimgray',
	'dimgrey',
	'dodgerblue',
	'firebrick',
	'floralwhite',
	'forestgreen',
	'fuchsia',
	'gainsboro',
	'ghostwhite',
	'gold',
	'goldenrod',
	'gray',
	'green',
	'greenyellow',
	'grey',
	'honeydew',
	'hotpink',
	'indianred',
	'indigo',
	'ivory',
	'khaki',
	'lavender',
	'lavenderblush',
	'lawngreen',
	'lemonchiffon',
	'lightblue',
	'lightcoral',
	'lightcyan',
	'lightgoldenrodyellow',
	'lightgray',
	'lightgreen',
	'lightgrey',
	'lightpink',
	'lightsalmon',
	'lightseagreen',
	'lightskyblue',
	'lightslategray',
	'lightslategrey',
	'lightsteelblue',
	'lightyellow',
	'lime',
	'limegreen',
	'linen',
	'magenta',
	'maroon',
	'mediumaquamarine',
	'mediumblue',
	'mediumorchid',
	'mediumpurple',
	'mediumseagreen',
	'mediumslateblue',
	'mediumspringgreen',
	'mediumturquoise',
	'mediumvioletred',
	'midnightblue',
	'mintcream',
	'mistyrose',
	'moccasin',
	'navajowhite',
	'navy',
	'oldlace',
	'olive',
	'olivedrab',
	'orange',
	'orangered',
	'orchid',
	'palegoldenrod',
	'palegreen',
	'paleturquoise',
	'palevioletred',
	'papayawhip',
	'peachpuff',
	'peru',
	'pink',
	'plum',
	'powderblue',
	'purple',
	'rebeccapurple',
	'red',
	'rosybrown',
	'royalblue',
	'saddlebrown',
	'salmon',
	'sandybrown',
	'seagreen',
	'seashell',
	'sienna',
	'silver',
	'skyblue',
	'slateblue',
	'slategray',
	'slategrey',
	'snow',
	'springgreen',
	'steelblue',
	'tan',
	'teal',
	'thistle',
	'tomato',
	'turquoise',
	'violet',
	'wheat',
	'white',
	'whitesmoke',
	'yellow',
	'yellowgreen',
]);

/**
 * Returns true if `color` is a valid CSS color value (hex, rgb/rgba, hsl/hsla,
 * or a CSS named color). Deterministic and environment-independent.
 */
export function isValidCssColor(color: unknown): boolean {
	if (!color || typeof color !== 'string') return false;
	const value = color.trim();
	if (value === '') return false;
	if (HEX_COLOR.test(value)) return true;
	if (RGB_COLOR.test(value)) return true;
	if (HSL_COLOR.test(value)) return true;
	return CSS_NAMED_COLORS.has(value.toLowerCase());
}

// Pieces of the strict grammar. A number is an optional sign and digits with an
// optional fraction, or a bare fraction (`255`, `-0.5`, `.25`): no exponent, no
// unit. A hue may also carry `deg`. Arguments are separated by spaces and tabs
// only, so a line break never passes.
const STRICT_NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const STRICT_ARG = `${STRICT_NUMBER}%?`;
const STRICT_HUE = `${STRICT_NUMBER}(?:deg)?`;
const STRICT_GAP = '[ \\t]';
const ASCII_LETTERS = /^[A-Za-z]+$/;

/**
 * `name(a, b, c)` and `name(a, b, c, alpha)` (comma syntax), or `name(a b c)`
 * and `name(a b c / alpha)` (CSS Color 4 space syntax). `first` is the pattern
 * of the first argument. Anchored, with no nested repetition, so a test cannot
 * backtrack catastrophically.
 */
function strictColorFunction(names: string, first: string): RegExp {
	const comma = `${STRICT_GAP}*,${STRICT_GAP}*`;
	const commaArgs = `${first}${comma}${STRICT_ARG}${comma}${STRICT_ARG}(?:${comma}${STRICT_ARG})?`;
	const spaceArgs =
		`${first}${STRICT_GAP}+${STRICT_ARG}${STRICT_GAP}+${STRICT_ARG}` +
		`(?:${STRICT_GAP}*/${STRICT_GAP}*${STRICT_ARG})?`;
	return new RegExp(
		`^(?:${names})\\(${STRICT_GAP}*(?:${commaArgs}|${spaceArgs})${STRICT_GAP}*\\)$`,
		'i'
	);
}

const STRICT_RGB_COLOR = strictColorFunction('rgba?', STRICT_ARG);
const STRICT_HSL_COLOR = strictColorFunction('hsla?', STRICT_HUE);

/**
 * True only for a color that is safe to write RAW into CSS text (a `<style>`
 * block, `insertCSS()`), where a looser check lets a value end its declaration
 * and start rules of its own: `red;} * { background: url(https://...) }`.
 *
 * Accepts exactly: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; `rgb()`, `rgba()`,
 * `hsl()` or `hsla()` with three numbers or percentages (the hue may carry
 * `deg`) and an optional alpha, in the comma or the space-and-slash syntax; a
 * CSS named color, `transparent` or `currentColor`, in ASCII letters of any
 * case. Anything else is refused: whitespace or a line break around the value,
 * `;`, `{`, `}`, quotes, backslash escapes, comments, and every other function
 * (`url()`, `var()`, `expression()`, `color-mix()`, `oklch()`).
 */
export function isStrictCssColor(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (HEX_COLOR.test(value)) return true;
	// ASCII first: `toLowerCase()` folds some non-ASCII letters to ASCII ones
	// (the Kelvin sign becomes `k`), which CSS would not.
	if (ASCII_LETTERS.test(value)) return CSS_NAMED_COLORS.has(value.toLowerCase());
	return STRICT_RGB_COLOR.test(value) || STRICT_HSL_COLOR.test(value);
}

/**
 * A copy of a palette for a writer that splices its colors into CSS text: each
 * string value that fails `isStrictCssColor()` becomes `''`, so none of it
 * reaches the CSS. The declaration it sat in is then dropped as invalid, or a
 * shorthand such as `border` falls back to its default color. Other values (an
 * optional color left out) are copied as they are. A value set through the
 * CSSOM (`element.style.color = value`, `setProperty()`) is parsed as a single
 * value and needs no such guard.
 */
export function strictCssColors<T extends object>(colors: T): T {
	const out = { ...colors };
	const writable = out as Record<string, unknown>;
	for (const [key, value] of Object.entries(writable)) {
		if (typeof value === 'string' && !isStrictCssColor(value)) writable[key] = '';
	}
	return out;
}
