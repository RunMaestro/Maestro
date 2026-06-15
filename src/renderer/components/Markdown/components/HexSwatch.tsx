/**
 * HexSwatch - the small colored square shown before inline code that contains a
 * hex color (e.g. `#FF8800`). Extracted because the identical markup was
 * duplicated across every inline-code renderer (chat, doc factory, wizard
 * bubble, release notes, mobile).
 */

export interface HexSwatchProps {
	color: string;
}

export function HexSwatch({ color }: HexSwatchProps) {
	return (
		<span
			style={{
				display: 'inline-block',
				width: '0.75em',
				height: '0.75em',
				backgroundColor: color,
				borderRadius: '2px',
				marginRight: '0.35em',
				verticalAlign: 'middle',
				border: '1px solid rgba(128, 128, 128, 0.3)',
			}}
		/>
	);
}
