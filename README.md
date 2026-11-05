# Prism — Minecraft Resource Studio

A local-first, Korean-language texture library and resource pack studio for Minecraft Java Edition.

## Run locally

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite. To create a production build, run `npm run build`.

## Windows desktop app

Download the latest Windows installer from [GitHub Releases](https://github.com/DiranCPS/app/releases/latest). The installer is not code-signed, so Windows may show a SmartScreen warning. To build it locally, install dependencies with `npm install` and run `npm run desktop:build`; the installer is written to `release/`. Run `npm run build` before `npm run desktop` to launch the built app without installing it.

## Deploy to GitHub Pages

The GitHub Actions workflow builds the app and deploys it to GitHub Pages when changes are pushed to `main` or `master`. In the repository settings, enable **Pages** with **GitHub Actions** as the build and deployment source. The workflow can also be started manually from the Actions tab.

## Features

- Load the complete vanilla PNG texture catalog directly from a local Minecraft Java client `.jar` without bundling or uploading game assets.
- Browse and search texture categories including blocks, items, entities, interface, armor, food, tools, nature, maps, environment, effects, and particles.
- Preview selected textures and adjust preview zoom.
- Replace a texture with a PNG while preserving its exact `assets/minecraft/textures/...` resource-pack path.
- Import PNG textures individually or merge textures from another resource-pack ZIP.
- Edit textures in a Paint-like pixel workspace with rectangular selection, move/resize and cut/copy/paste, pencil, eraser, fill, color picker, line and rectangle tools, opacity and brush-size controls, a color palette, zoom, pixel grid, undo/redo, and transparent-canvas support; create new 16 × 16 PNG textures and download an individual PNG.
- Delete imported textures from the library and remove them from the exported pack overrides.
- Choose Minecraft Java versions by release family, from 1.6.x through 1.21.x and 26.x, and set a minimum supported version for the selected range.
- Open pack settings from the gear beside export to edit pack metadata, locate the `.minecraft` folder, or choose where exported packs are saved.
- Save the local texture library in browser storage, and export selected overrides as a Minecraft resource-pack ZIP with `pack.mcmeta`.

To load the vanilla textures, choose the `.minecraft` folder in pack settings or select a version JAR, usually at `%APPDATA%\.minecraft\versions\<version>\<version>.jar`. Browsers require you to grant folder access; after permission is granted, the app remembers the folder handle and can search it when it starts again. Exports go to the browser's Downloads location by default, or to a folder you choose in settings. The app reads game archives locally in your browser.
