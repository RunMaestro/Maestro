---
title: Achievements
description: Level up through 11 conductor-themed ranks based on your cumulative Auto Run time.
icon: trophy
---

Maestro features a conductor-themed achievement system that tracks your cumulative Auto Run time. The focus is simple: **longest run wins**. As you accumulate Auto Run hours, you level up through 11 ranks inspired by the hierarchy of orchestral conductors.

![Achievements](./screenshots/achievements.png)

## Conductor Ranks

| Level | Rank                          | Time Required | Example Conductor              |
| :---: | ----------------------------- | ------------- | ------------------------------ |
|   1   | **Apprentice Conductor**      | 15 minutes    | Gustavo Dudamel (early career) |
|   2   | **Assistant Conductor**       | 1 hour        | Marin Alsop                    |
|   3   | **Associate Conductor**       | 8 hours       | Yannick Nezet-Seguin           |
|   4   | **Resident Conductor**        | 24 hours      | Jaap van Zweden                |
|   5   | **Principal Guest Conductor** | 1 week        | Esa-Pekka Salonen              |
|   6   | **Chief Conductor**           | 30 days       | Andris Nelsons                 |
|   7   | **Music Director**            | 3 months      | Sir Simon Rattle               |
|   8   | **Maestro Emeritus**          | 6 months      | Bernard Haitink                |
|   9   | **World Maestro**             | 1 year        | Kirill Petrenko                |
|  10   | **Grand Maestro**             | 5 years       | Riccardo Muti                  |
|  11   | **Titan of the Baton**        | 10 years      | Leonard Bernstein              |

## Reaching the Top

Since Auto Runs can execute in parallel across multiple Maestro sessions, achieving **Titan of the Baton** (Level 11) is technically feasible in less than 10 calendar years. Run 10 agents simultaneously with worktrees and you could theoretically hit that milestone in about a year of real time.

But let's be real - getting to Level 11 is going to take some serious hacking. You'll need a well-orchestrated fleet of agents running around the clock, carefully crafted playbooks that loop indefinitely, and the infrastructure to keep it all humming. It's the ultimate test of your Maestro skills.

The achievement panel shows your current rank, progress to the next level, and total accumulated time. Each rank includes flavor text and information about a legendary conductor who exemplifies that level of mastery.

## Sharing Your Achievements

Generate a shareable image of your achievements to celebrate milestones or compare progress with other Maestro users. The share image captures **unique statistics not tracked anywhere else** in the app.

![Achievement Share Image](./screenshots/achievements-share.png)

**To generate a share image:**

1. Open the Achievements panel
2. Click **Share** in the header
3. Choose **Copy to Clipboard** or **Save as Image**

### Stats Captured in Share Images

The share image includes comprehensive usage statistics:

| Stat                  | Description                                          |
| --------------------- | ---------------------------------------------------- |
| **Sessions**          | Total number of AI sessions created                  |
| **Total Tokens**      | Cumulative tokens processed across all sessions      |
| **Total AutoRun**     | Cumulative Auto Run execution time                   |
| **Longest AutoRun**   | Your personal record for longest continuous Auto Run |
| **Hands-on Time**     | Time spent actively interacting with Maestro         |
| **Registered Agents** | Peak number of agents you've configured              |
| **Parallel AutoRuns** | Peak simultaneous Auto Runs achieved                 |
| **Parallel Queries**  | Peak simultaneous AI queries in flight               |
| **Queue Depth**       | Peak message queue depth reached                     |

These peak usage stats are tracked automatically and persist across sessions. They represent your high-water marks - evidence of your most intensive Maestro orchestrations.

## Keyboard Mastery

Separate from Conductor ranks, Maestro tracks your **keyboard mastery** based on shortcut usage. As you discover and use more keyboard shortcuts, you level up through 5 mastery levels:

| Level | Title            | Shortcuts Used |
| :---: | ---------------- | -------------- |
|   0   | Beginner         | 0-24%          |
|   1   | Student          | 25-49%         |
|   2   | Performer        | 50-74%         |
|   3   | Virtuoso         | 75-99%         |
|   4   | Keyboard Maestro | 100%           |

Your current keyboard mastery level and progress are shown in the **Keyboard Shortcuts panel** (press `?` or `Cmd/Ctrl+/` to open). The panel displays which shortcuts you've used (marked with a checkmark) and which remain to be discovered. See [Keyboard Shortcuts](./keyboard-shortcuts) for the full shortcut reference.

## Leaderboard

Opt-in to compete with fellow Maestro users on the global **Leaderboard** at [RunMaestro.ai](https://runmaestro.ai). Sign up to have your stats tracked and compete for top rankings.

![Leaderboard](./screenshots/leaderboard.png)

The leaderboard tracks two competitive categories:

| Category                     | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| **Cumulative Auto Run Time** | Total time spent in Auto Run across all sessions |
| **Longest Single Auto Run**  | Personal record for longest continuous Auto Run  |

Each entry shows the user's conductor badge level, social links, and ranking. Your stats sync across devices when you're signed in, so your achievements follow you wherever you use Maestro.

Your leaderboard avatar is sourced from GitHub. Link your GitHub profile in the registration form, and update your picture on GitHub to change how it appears on the leaderboard.
