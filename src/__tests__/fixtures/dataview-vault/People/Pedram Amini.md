---
created: 2026-08-01
aliases:
  - Pedram
tags:
  - person
---

# Pedram Amini

```dataview
TABLE file.cday as Created, Summary
FROM #meeting or "meetings"
WHERE contains(file.outlinks, this.file.link)
SORT file.cday DESC
LIMIT 25
```

```dataview
TABLE Company, Role
FROM "People"
WHERE contains(Connection, this.file.link)
SORT file.cday DESC
LIMIT 25
```
