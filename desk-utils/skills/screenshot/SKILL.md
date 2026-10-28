---
name: screenshot
description: Use when you need to see what is currently on the user's Windows screen — "сделай скриншот", "покажи что на экране", "заскринь", "screenshot my screen", or when the user is working remotely and asks you to look at their display. Captures the screen to a PNG and reads it back visually. Windows only. A level or viewport shot from the Unreal Editor is unreal-editor.
---

# screenshot — capture the Windows screen and read it

Use this to *see* the user's screen. Useful for remote work: the user is away from the machine and wants you to look at what's displayed (an error dialog, an editor, a browser, a game window).

Flow: run a PowerShell capture → save a PNG into the **session scratchpad directory** → `Read` that PNG (images are read visually). Then answer from what you see.

## Capture command

Run this via the PowerShell tool. Replace `<OUT>` with an absolute path in your session scratchpad, e.g. `.../scratchpad/screen.png`. By default it grabs the **whole virtual desktop (all monitors)**.

```powershell
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[Dpi]::SetProcessDPIAware() | Out-Null   # capture at physical pixels on scaled displays
$b   = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('<OUT>', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"$($b.Width)x$($b.Height) -> <OUT>"
```

Then `Read` `<OUT>`.

## Variants

- **Primary monitor only** — swap the bounds line for:
  `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds`
- **A specific monitor** — enumerate `[System.Windows.Forms.Screen]::AllScreens`, index into it, use `.Bounds`.
- **Active foreground window only** — get the foreground `HWND` via `GetForegroundWindow` + `GetWindowRect` (P/Invoke `user32.dll`) and pass that rect. Only bother if the full grab is too busy to read.

## Notes
- Windows-only (uses GDI+ / WinForms). It captures the desktop as the interactive session sees it — it will **not** work from a truly headless/service context with no session.
- If the PNG comes back blank or black, a protected surface (DRM video, some full-screen games, secure UAC desktop) is on screen — capture can't see those; say so rather than guessing.
- Reuse one filename (e.g. `screen.png`) and overwrite it; no need to keep a history unless asked.
- Multi-monitor grabs get large — a downscale isn't needed for `Read`, but if the user only cares about one window, prefer the window/primary variant to keep the image legible.
