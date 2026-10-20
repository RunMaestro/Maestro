---
created: 2026-09-25
---

# JS Demo

```dataviewjs
dv.table(
	['Meeting', 'Created'],
	dv.pages('#meeting').sort((p) => p.file.cday, 'desc').map((p) => [p.file.link, p.file.cday])
);
```

```dataviewjs
dv.paragraph(app.vault.getMarkdownFiles().length + ' files');
```

```dataviewjs
await dv.view('views/sample', { title: 'People' });
```

```dataviewjs
const rows = await dv.io.csv('data/people.csv');
dv.table(['Name', 'Company'], rows.map((r) => [r.name, r.company]));
```

This page is called `$= dv.current().file.name`.
