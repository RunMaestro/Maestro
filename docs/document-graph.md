---
title: Document Graph
description: Visualize markdown file relationships and wiki-link connections in an interactive graph view.
icon: diagram-project
---

The Document Graph provides an interactive visualization of your markdown files and their connections. See how documents link to each other through wiki-links (`[[link]]`) and standard markdown links, making it easy to understand your documentation structure at a glance.

![Document Graph](./screenshots/document-graph.png)

## Opening the Document Graph

There are several ways to access the Document Graph:

### From File Preview

When viewing a markdown file in File Preview, press `Cmd+Shift+G` / `Ctrl+Shift+G` to open the Document Graph focused on that file. Press `Esc` to return to the File Preview. This is the primary way to open the Document Graph.

### From Quick Actions

Press `Cmd+K` / `Ctrl+K` and search for "Open Last Document Graph" to re-open the most recently viewed graph.

<Note>
The "Open Last Document Graph" option only appears after you've opened a Document Graph at least once during your session.
</Note>

### From the File Explorer

After you've opened a Document Graph at least once, a **graph icon** (branch icon) appears in the Files tab header. Click it to re-open the last viewed graph.

![Last Graph Button](./screenshots/document-graph-last-graph.png)

### From File Context Menu

Right-click any markdown file in the File Explorer and select **Document Graph** to open the graph focused on that file.

### Using Go to File

Press `Cmd+G` / `Ctrl+G` to open the fuzzy file finder, navigate to any markdown file, then use `Cmd+Shift+G` to jump to the Document Graph from there.

## Navigating the Graph

The Document Graph is designed for keyboard-first navigation:

| Action | Key |
|--------|-----|
| Navigate between nodes | `Arrow Keys` (spatial detection) |
| Recenter view on node | `Enter` (for document nodes) |
| Open external URL | `Enter` (for external link nodes) |
| Open document in File Preview | `O` |
| Focus search | `Cmd/Ctrl+F` |
| Close graph or help panel | `Esc` |

### Mouse Controls

- **Click** a node to select it
- **Double-click** a node to recenter the view on it
- **Drag** nodes to reposition them
- **Scroll** to zoom in and out
- **Pan** by dragging the background

## Graph Controls

The toolbar at the top of the Document Graph provides several options:

### Depth Control

Adjust the **Depth** slider to control how many levels of connections are shown from the focused document:

- **Depth: 0 (All)** — Show all connected documents regardless of distance
- **Depth: 1** — Show only direct connections
- **Depth: 2** — Show connections and their connections (default)
- **Depth: 3-5** — Show deeper relationship chains

Lower depth values keep the graph focused and improve performance; higher values reveal more of the document ecosystem. The depth can be adjusted from 0 (All) to 5.

### External Links

Toggle **External** to show or hide external URL links found in your documents:

- **Enabled** — External links appear as separate domain nodes (e.g., "github.com", "docs.example.com")
- **Disabled** — Only internal document relationships are shown

External link nodes help you see which external resources your documentation references.

### Search

Use the search box to filter documents by name. Matching documents are highlighted in the graph.

## Understanding the Graph

### Node Types

- **Document nodes** — Your markdown files, showing the filename and a preview of content
- **External link nodes** — Domains of external URLs referenced in your documents
- **Focused node** — The currently selected document (highlighted with a different border)

### Edge Types

Lines between nodes represent different types of connections:

- **Wiki-links** — `[[document-name]]` style links
- **Markdown links** — `[text](path/to/file.md)` style links
- **External links** — Links to URLs outside your project

### Node Information

Each document node displays:

- **Filename** — The document name
- **Folder indicator** — Shows the parent directory (e.g., "docs")
- **Content preview** — A snippet of the document's content

## Tips for Effective Use

### Workflow Integration

1. Use `Cmd+G` to quickly find a file
2. Open it in File Preview to read or edit
3. Press `Cmd+Shift+G` to see its connections in the Document Graph
4. Press `O` to open a connected document
5. Press `Esc` to return to File Preview

### Large Documentation Sets

For projects with many markdown files:

- Start with **Depth: 1** to see immediate connections
- Increase depth gradually to explore relationships
- Use **Search** to find specific documents quickly
- Drag nodes to organize the view — positions persist

### Understanding Documentation Structure

The Document Graph is especially useful for:

- **Auditing links** — Find orphaned documents with no incoming links
- **Understanding navigation** — See how documents connect for readers
- **Planning restructuring** — Visualize the impact of moving or renaming files
- **Onboarding** — Help new team members understand documentation architecture

## Keyboard Shortcut Summary

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Open from File Preview | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| Re-open last graph | Via `Cmd+K` menu | Via `Ctrl+K` menu |
| Go to File (fuzzy finder) | `Cmd+G` | `Ctrl+G` |
| Navigate nodes | `Arrow Keys` | `Arrow Keys` |
| Recenter on node | `Enter` | `Enter` |
| Open document in preview | `O` | `O` |
| Focus search | `Cmd+F` | `Ctrl+F` |
| Close graph | `Esc` | `Esc` |
