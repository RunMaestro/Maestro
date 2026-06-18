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
