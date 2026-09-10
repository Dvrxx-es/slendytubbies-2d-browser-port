# Slendytubbies 2D Browser Edition

Fan adaptation for desktop and Android browsers. Original game, characters, sprites and maps: ZeoWorks. Original menu music: RCstudio. This is an unofficial browser adaptation, not an official ZeoWorks release.

14 selectable environments including the original Blue Room bonus scene, a configurable objective of 1–25 custards (default 10), mouse flashlight, Android dual touch controls and cooperative rooms for up to four players.

## Render

Create a free Node Web Service from this repository:

- Build: `npm ci && npm run build`
- Start: `npm start`
- Health check: `/health`

The service serves the game and its WebSocket endpoint `/rooms` together. Render provides the HTTPS / WSS URL on `onrender.com`. No database or external signalling service is needed. Room codes are eight characters. The host selects the map and custard count before creating a room; every player shares that objective. The host runs the game simulation; Render relays authenticated room state. Rooms close when the host disconnects. A restart removes active rooms. Render's free plan can sleep after idle periods and its initial wake-up can take about one minute.

## Local development

Requires Node 22 or later. Run `npm ci`, `npm run build`, then `npm start`, and open `http://localhost:10000`. `npm test` runs real WebSocket multiplayer checks against a temporary local server.

Controls: WASD/arrows to move, mouse to aim, Shift to toggle running without a stamina limit, F for flashlight, M for map and Escape to pause. Android provides a left movement stick, a right aiming stick and red run/flashlight buttons. Tap Run once to enable running and again to disable it.

`public.tar.gz` contains the browser game and visual assets; `audio.tar.gz` contains the original music and enemy screams. Both archives are extracted during the build. `server.mjs` contains the HTTP / WebSocket server. Mainland uses original solid collision geometry scaled together with its scenery; Mountains uses original custard slots restricted to paths the player can traverse.
