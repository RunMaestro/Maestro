/**
 * getSvgPathFromStroke — Canonical helper from perfect-freehand's README.
 *
 * Converts the outline-points array returned by `getStroke()` into an SVG
 * `d` attribute string using quadratic Bézier curves between midpoints,
 * which produces a smooth closed shape suitable for a `<path fill={...}>`.
 */

const average = (a: number, b: number): number => (a + b) / 2;

export default function getSvgPathFromStroke(points: number[][]): string {
	const len = points.length;
	if (len < 4) return '';

	const a = points[0];
	const b = points[1];
	const c = points[2];

	let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;

	for (let i = 2, max = len - 1; i < max; i++) {
		const p = points[i];
		const q = points[i + 1];
		result += `${average(p[0], q[0]).toFixed(2)},${average(p[1], q[1]).toFixed(2)} `;
	}

	result += 'Z';

	return result;
}
