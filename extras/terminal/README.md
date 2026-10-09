# Terminal profiles for IQ Code

A plugin cannot paint your terminal's own background, so these profiles set it, with the text, cursor, selection and the 16 ANSI colours to match the IQ themes.

- **IQ Light**: pair the `IQ-Light` profile with the **IQ Light** theme (`/theme`). Background `#f1f3f4`.
- **IQ Dark**: pair the `IQ-Dark` profile with the **IQ Dark** theme. Background `#1f2023`.

Nothing here is installed for you. Import the file for your terminal by hand. Download the profiles from the public IQ Code repository under `extras/terminal/`, or use this folder in a downloaded copy of the repository.

## macOS Terminal.app

Double-click `IQ-Light.terminal` (or `IQ-Dark.terminal`). Terminal adds the profile. Open Terminal's Settings, go to Profiles and select it. Click Default to use it for new windows.

## iTerm2

Open Settings, go to Profiles, then Colors. Open the Color Presets menu, choose Import, and pick `IQ-Light.itermcolors` (or `IQ-Dark.itermcolors`). Then choose that preset from the same menu for your profile.

## Ghostty

From the root of your downloaded repository, copy the theme file into Ghostty's themes folder, then name it in your config:

```sh
mkdir -p ~/.config/ghostty/themes
cp extras/terminal/ghostty/iq-light ~/.config/ghostty/themes/
```

Add this line to `~/.config/ghostty/config` (use `iq-dark` for the dark theme), then restart Ghostty:

```
theme = iq-light
```

## What the colours are

The foreground and ANSI colours 1 to 7 read at 4.5:1 or better on each background (measured when the profiles were made).

The desktop app keeps its own background, so these profiles do not change it.
