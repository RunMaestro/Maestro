---
created: 2026-09-28
---

# Query Gallery

## LIST

```dataview
LIST
FROM "People"
SORT file.name ASC
```

## TABLE WITHOUT ID

```dataview
TABLE WITHOUT ID file.link AS Note, Summary
FROM "meetings"
WHERE Summary
SORT file.name ASC
```

## TASK

```dataview
TASK
FROM "Notes"
WHERE !completed
```

## GROUP BY

```dataview
TABLE rows.file.link AS People
FROM "People"
GROUP BY Company
```

## FLATTEN

```dataview
TABLE Connection
FROM "People"
FLATTEN Connection
```

## CALENDAR (not supported)

```dataview
CALENDAR file.cday
FROM "meetings"
```

## Parse error

```dataview
TABLE FROM WHERE
```
