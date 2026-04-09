# Curling Club Bracket Viewer

A Chrome extension that adds a graphical bracket tree to curlingseattle.org bonspiel team pages.

## Install in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select this folder (`CurlingClubTree`)
5. Navigate to any team page on curlingseattle.org, e.g.:
   `https://curlingseattle.org/bonspiels?event=2026April&disp=team&teamid=7`

The graphical bracket will appear above the original list view.

## How it works

- Parses the nested win/loss game list from the team view
- Lays out games left-to-right by draw time
- Win paths branch upward (green), lose paths downward (red)
- Color coding matches the site's bracket tiers (A=yellow, B=blue, C=pink, D=purple)
- Orange border = next upcoming game (no score yet)
- "Hide Original View" button toggles the site's original list

## Files

- `manifest.json` — extension config
- `content.js` — page parser + SVG renderer
- `styles.css` — bracket styling
