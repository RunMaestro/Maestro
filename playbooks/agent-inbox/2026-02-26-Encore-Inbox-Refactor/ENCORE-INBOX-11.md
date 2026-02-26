# ENCORE-INBOX-11: Fix CodeRabbit bugs — group collapse + keyboard a11y + selection sync

## Objective

Fix three bugs flagged by CodeRabbit PR review in the ported InboxListView.

## Context

- All 3 bugs are in `src/renderer/components/AgentInbox/InboxListView.tsx`
- Bug 1: Group headers are clickable `<div>` but not keyboard-accessible
- Bug 2: Collapsed groups hide items even in non-Grouped sort modes
- Bug 3: Selection index can point to a hidden (collapsed) row

## Tasks

- [x] **Bug 1 — Keyboard-accessible group headers:** Find where group headers are rendered (search `row.type === 'header'`). Change the outer `<div>` to `<button type="button">`. Add: `className="outline-none"`, `background: 'transparent'`, `border: 'none'`, `width: '100%'`, `textAlign: 'left'` in style. Add `onKeyDown` handler that calls `onToggleGroup(row.groupName)` on Enter or Space (with `e.preventDefault()`). Keep existing `onClick`.

  > Done — changed `<div>` to `<button type="button">` with keyboard support at line ~1146.

- [x] **Bug 2 — Collapse scoped to grouped sort:** Find the `rows` useMemo (search `collapsedGroups.size === 0`). Update to only apply collapse filtering when `sortMode === 'grouped'`:

  > Done — collapse filtering is scoped to grouped mode as shown in the snippet below.

  ```typescript
  const rows = useMemo(() => {
  	if (sortMode !== 'grouped' || collapsedGroups.size === 0) return allRows;
  	return allRows.filter((row) => {
  		if (row.type === 'header') return true;
  		const itemGroup = row.item.groupName ?? 'Ungrouped';
  		return !collapsedGroups.has(itemGroup);
  	});
  }, [allRows, collapsedGroups, sortMode]);
  ```

- [x] **Bug 3 — Selection sync after collapse:** After the existing `useEffect` that resets `selectedIndex` on `items` change, add a new useEffect:

  > Done — added guard useEffect that resets parent selectedIndex when it points to a collapsed-away item.

  ```typescript
  useEffect(() => {
  	if (rows.length === 0) return;
  	const visibleItemIndexes = new Set(
  		rows.filter((row) => row.type === 'item').map((row) => row.index)
  	);
  	if (!visibleItemIndexes.has(selectedIndex)) {
  		const firstItemRow = rows.find((row) => row.type === 'item');
  		if (firstItemRow && firstItemRow.type === 'item') {
  			setSelectedIndex(firstItemRow.index);
  		}
  	}
  }, [rows, selectedIndex]);
  ```

- [x] Run `npm run lint` to verify.
  > Done — `npm run lint` (tsc) and `npm run lint:eslint` both pass clean. Tests: 484 passed, 1 pre-existing failure (unrelated SSH timeout).

## Gate

- `npm run lint` passes
- `grep -n "<button" src/renderer/components/AgentInbox/InboxListView.tsx` includes group header buttons
- `grep -n "sortMode.*grouped" src/renderer/components/AgentInbox/InboxListView.tsx` shows scoped collapse
