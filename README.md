# JohnnyGrab

A VS Code sidebar for macOS that records iOS Simulator videos and takes screenshots sized for App Store Connect.

## Why it helps

App Store Connect is strict about media. A video with the wrong size, a variable frame rate or no audio track is rejected at upload. A screenshot with an alpha channel is too. Getting it right by hand means screen recording, then re-encoding, resizing, adding a silent audio track and stripping transparency, usually with ffmpeg and a page of Apple's specs open.

JohnnyGrab does all of that in one click:

- **Every file comes out at a size Apple accepts.** Videos are exported at the exact dimensions, codec, bit rate and constant 30 fps that App Store Connect asks for.
- **App Previews get the silent audio track Apple requires**, so they upload the first time.
- **Screenshots have the alpha channel removed**, which App Store Connect otherwise rejects.
- **The status bar looks like Apple's**: 9:41, full signal and a charged battery, instead of whatever time and battery the simulator happened to show.
- **A checklist shows which screenshot sizes you still need**, so you know when a submission is complete.

You stay in VS Code next to your project, and you don't need ffmpeg or any other tool beyond Xcode.

## Features

- **Header video**: exactly 3840x1646, constant 30 fps, H.264, no audio (5-30 s, default 10)
- **Search Results video**: 3:2, from 1920x1280 to 3840x2560, constant 30 fps, H.264, no audio (5-30 s, default 6)
- **App Preview video**: 1920x886 / 886x1920 for iPhone and iPhone Duo, 1600x1200 / 1200x1600 for iPad; H.264 High 4.0 at 11 Mbps, constant 30 fps, plus the silent stereo 256 kbps AAC 48 kHz track Apple requires (15-30 s, default 16)
- **Capture screenshots** from every booted simulator at native size, with the alpha channel removed. On an iPhone Duo both panels are captured and the black one (the panel that isn't showing) is dropped, labeled closed or open.
- **Checklist** of the four screenshot sizes (iPhone Pro Max, iPad 13", Duo closed, Duo open), ticked when a matching file is in the output folder
- **Clean status bar**: Apple's 9:41, full Wi-Fi and cellular bars, charged battery. **Reset status bar** clears it.
- Result card with thumbnail, size, length and frame rate, plus **Open** and **Reveal in Finder**

Files are named `<app>-<kind>-<WxH>-<HHmmss>.<ext>` and are never overwritten.

## Requirements

- macOS with Xcode 26 or later (the helper uses the macOS 26 AVFoundation APIs)
- A booted simulator. JohnnyGrab never boots, rotates or installs anything.

On first use JohnnyGrab compiles its Swift helper (`swift/johnnygrab-tool.swift`) with `xcrun swiftc -O` into the extension's global storage folder. Compiler errors appear in the **JohnnyGrab** output panel.

## Install

1. In VS Code, open the Extensions view
2. Search for **JohnnyGrab**
3. Click **Install**

## Usage

1. Click the JohnnyGrab icon in the Activity Bar
2. Pick a booted simulator (press **Refresh** after booting another). For an iPhone Duo, choose the **Open** or **Closed** panel.
3. Type the app name and pick the output folder
4. Set the length and press **Record**, or press **Capture screenshots**

Recordings run for the chosen length plus 2 seconds, and the first part is kept. Raw recordings go to a temp folder and are deleted after export.

## Settings

- `johnnygrab.outputFolder`: where files are saved (default `~/Desktop`)
- `johnnygrab.captureDelay`: seconds to wait after you press Record or Capture before JohnnyGrab starts, so the app can settle (default `3`, up to `30`)
- `johnnygrab.statusBarTime`: status bar time (default `2007-01-09T09:41:00`, shown as 9:41 in your time zone; `9:41` also works)
