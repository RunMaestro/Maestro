import { describe, it, expect } from 'vitest';
import {
	BASE_PAD,
	GUIDE_OFFSET,
	INDENT_STEP,
	annotateTreeLines,
	guideLeft,
	rowPaddingLeft,
} from '../../../../../renderer/components/FileExplorerPanel/utils/treeLines';
import type { FlattenedNode } from '../../../../../renderer/components/FileExplorerPanel/types';

/**
 * Builds a flat row list from an indent sketch. Each entry is `depth:name`,
 * written in the order the tree renders, so a test reads like the panel looks.
 */
const rows = (sketch: string[]): FlattenedNode[] =>
	sketch.map((entry, i) => {
		const [depth, name] = entry.split(':');
		return {
			node: { name, type: name.includes('.') ? 'file' : 'folder' },
			path: name,
			depth: Number(depth),
			globalIndex: i,
			isLastChild: false,
			ancestorGuideMask: 0,
		} as FlattenedNode;
	});

describe('tree line geometry', () => {
	it('keeps the indent step equal to the chevron slot plus the row gap', () => {
		// w-3 (12px) + gap-2 (8px). Files reserve the chevron slot, so a file and
		// a folder at the same depth land in one icon column only while this holds.
		expect(INDENT_STEP).toBe(20);
		expect(guideLeft(0)).toBe(GUIDE_OFFSET);
		expect(guideLeft(3) - guideLeft(2)).toBe(INDENT_STEP);
		expect(rowPaddingLeft(0)).toBe(BASE_PAD);
		expect(rowPaddingLeft(3) - rowPaddingLeft(2)).toBe(INDENT_STEP);
	});

	it("places a row's elbow column one indent step left of its own icon", () => {
		for (const depth of [1, 2, 5]) {
			expect(rowPaddingLeft(depth) - guideLeft(depth - 1)).toBe(
				INDENT_STEP - GUIDE_OFFSET + BASE_PAD
			);
			expect(guideLeft(depth - 1)).toBeLessThan(rowPaddingLeft(depth));
		}
	});
});

describe('annotateTreeLines', () => {
	it('marks the last visible child at every level', () => {
		const tree = rows(['0:a', '1:b', '2:x.md', '1:c', '0:d']);
		annotateTreeLines(tree);
		expect(tree.map((r) => r.isLastChild)).toEqual([false, false, true, true, true]);
	});

	it('treats a lone root row as a last child', () => {
		const tree = rows(['0:only']);
		annotateTreeLines(tree);
		expect(tree[0].isLastChild).toBe(true);
	});

	it('keeps an ancestor guide alive only while that ancestor has more to come', () => {
		//   a/          <- has a following sibling (d), so column 0 stays lit
		//     b/
		//       x.md
		//     c/
		//       y.md
		//   d/
		const tree = rows(['0:a', '1:b', '2:x.md', '1:c', '2:y.md', '0:d']);
		annotateTreeLines(tree);
		const [a, b, x, c, y, d] = tree;
		expect(a.ancestorGuideMask).toBe(0);
		expect(b.ancestorGuideMask).toBe(0);
		// x sits under b, which still has sibling c, but column 1 is x's own elbow
		// column, so only column 0 (kept alive by d) is a pass-through guide.
		expect(x.ancestorGuideMask).toBe(0b1);
		expect(c.ancestorGuideMask).toBe(0);
		// y sits under c, the last child of a, so column 0 is still alive via d.
		expect(y.ancestorGuideMask).toBe(0b1);
		expect(d.ancestorGuideMask).toBe(0);
	});

	it('drops an ancestor guide once that ancestor is the last child', () => {
		//   a/
		//     b/          <- last child of a
		//       c/        <- last child of b
		//         x.md
		//   (nothing after a)
		const tree = rows(['0:a', '1:b', '2:c', '3:x.md']);
		annotateTreeLines(tree);
		// a is the last root row, b the last child of a: neither column survives
		// into x's row, so x draws no pass-through guides at all.
		expect(tree[3].ancestorGuideMask).toBe(0);
	});

	it('reproduces the reporter mirror tree from #1585', () => {
		// Level N/ holds Level N+1/ and Doc Level N.md, so every .md row closes out
		// its folder while every folder above it still has an .md row to come.
		const tree = rows([
			'0:Level 1',
			'1:Level 2',
			'2:Level 3',
			'3:Doc Level 3.md',
			'2:Doc Level 2.md',
			'1:Doc Level 1.md',
			'0:Doc Level 0.md',
		]);
		annotateTreeLines(tree);
		expect(tree.map((r) => r.isLastChild)).toEqual([
			false, // Level 1 - Doc Level 0.md follows it at the root
			false, // Level 2 - Doc Level 1.md follows it inside Level 1
			false, // Level 3 - Doc Level 2.md follows it inside Level 2
			true, // every Doc Level N.md closes out its folder
			true,
			true,
			true,
		]);
		// 'Doc Level 3.md' at depth 3: column 2 is its own elbow column, and
		// columns 0 and 1 stay lit because 'Level 1' and 'Level 2' each still
		// have their own .md row further down.
		expect(tree[3].ancestorGuideMask).toBe(0b11);
	});

	it('does nothing to an empty tree', () => {
		const tree: FlattenedNode[] = [];
		expect(() => annotateTreeLines(tree)).not.toThrow();
		expect(tree).toEqual([]);
	});
});
