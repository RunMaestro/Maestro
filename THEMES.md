# Themes

Maestro ships with a variety of themes that fall under three categories: Dark, Light, and "Vibes". Here are screenshots of the main window in each theme.

## Dark

### Dracula

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/bf76f858-e37d-48f5-966b-ee226f42cb76" />

### Monokai

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/09db8891-4303-419a-b4ab-be729cf65e04" />

### Nord

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/1c413246-5342-47d7-a012-4d50f7dd49ea" />

### Tokyo Night

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/9ede9789-bf71-4c1c-beec-b242cdb89a22" />

### Catppuccin Mocha

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/64c6a699-cb64-4d5a-a245-69ab29cb59e3" />

### Gruvbox Dark

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/3dab3ae6-ff18-4d66-aca5-ff5ef57096f2" />

### Solarized Dark

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/24033392-3ac5-495c-9cd9-2587d2f0b5eb" />

## Light

### GitHub

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/b09e466a-5dbf-4510-80b9-a84815c52d14" />

### Solarized

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/a1848b27-f96d-44e1-85f5-8e383acde1e6" />

### One Light

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/ac7fd12c-f455-4b6f-9aa2-ad4fb4f1ea12" />

### Gruvbox Light

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/c0fd1590-93c7-4303-ba03-70d7ae7e25ee" />

### Catppuccin Latte

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/33fcb801-7978-4af4-b10d-7e9d5c9301e6" />

### Ayu Light

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/ace98cd5-ef7d-4f52-bd5f-2d2af75f81a8" />

## Vibes

### Pedurple

Purple is Pedram's favorite color.
<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/15875d3e-37c1-4b6c-b967-551afd40b658" />

### Maestro's Choice

We asked Maestro to make a theme for itself, this is what it came up with.
<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/2af219f3-220d-4587-b147-692580c2acf6" />

### Dre Synth

It's a vibe.
<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/fc20b716-b959-47b9-b2f0-f78df2a63329" />

### InQuest

An homage to InQuest.net, acquired by OPSWAT in 2024.
<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/7d10495d-6d66-41ce-83d9-36ba8681e3db" />

---

## Showcase Commands

Launch the showcase in any theme with a window sized to match these screenshots (1796x1151 logical pixels, 3592x2302 at 2x retina):

```bash
# Default (Dracula)
npm run dev:showcase

# With a specific theme
npm run dev:showcase -- --theme <id>

# With theme and exact screenshot window size
npm run dev:showcase -- --theme <id> --size 1796x1151
```

### Commands per theme

| Theme            | Command                                                             |
| ---------------- | ------------------------------------------------------------------- |
| Dracula          | `npm run dev:showcase -- --theme dracula --size 1796x1151`          |
| Monokai          | `npm run dev:showcase -- --theme monokai --size 1796x1151`          |
| Nord             | `npm run dev:showcase -- --theme nord --size 1796x1151`             |
| Tokyo Night      | `npm run dev:showcase -- --theme tokyo-night --size 1796x1151`      |
| Catppuccin Mocha | `npm run dev:showcase -- --theme catppuccin-mocha --size 1796x1151` |
| Gruvbox Dark     | `npm run dev:showcase -- --theme gruvbox-dark --size 1796x1151`     |
| Solarized Dark   | `npm run dev:showcase -- --theme solarized-dark --size 1796x1151`   |
| GitHub           | `npm run dev:showcase -- --theme github-light --size 1796x1151`     |
| Solarized Light  | `npm run dev:showcase -- --theme solarized-light --size 1796x1151`  |
| One Light        | `npm run dev:showcase -- --theme one-light --size 1796x1151`        |
| Gruvbox Light    | `npm run dev:showcase -- --theme gruvbox-light --size 1796x1151`    |
| Catppuccin Latte | `npm run dev:showcase -- --theme catppuccin-latte --size 1796x1151` |
| Ayu Light        | `npm run dev:showcase -- --theme ayu-light --size 1796x1151`        |
| Pedurple         | `npm run dev:showcase -- --theme pedurple --size 1796x1151`         |
| Maestro's Choice | `npm run dev:showcase -- --theme maestros-choice --size 1796x1151`  |
| Dre Synth        | `npm run dev:showcase -- --theme dre-synth --size 1796x1151`        |
| InQuest          | `npm run dev:showcase -- --theme inquest --size 1796x1151`          |

### Adding a screenshot

To get a hosted image URL for a new theme screenshot:

1. Take a screenshot while running the showcase at the correct size (`--size 1796x1151`)
2. Open any GitHub issue or pull request in this repo
3. Drag and drop the screenshot into the comment box — GitHub will upload it and generate a `https://github.com/user-attachments/assets/...` URL
4. Copy that URL and use it in the `<img>` tag when adding the theme section above
