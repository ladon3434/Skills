---
name: clipboard
description: Use to read from or write to the Windows clipboard — "что у меня в буфере", "возьми из буфера обмена", "скопируй это в буфер", "put this on my clipboard", or when the user refers to something they just copied without giving a file. Handles text, images, and copied files. Windows only.
---

# clipboard — read/write the Windows clipboard

Bridge between the user's clipboard and the conversation. Common uses: pull in text/an image the user just copied instead of asking for a file; push a result (a command, a snippet, an answer) straight to their clipboard so they can paste it.

Run these via the PowerShell tool.

## Read

- **Text** (most common):
  ```powershell
  Get-Clipboard -Raw
  ```
  `-Raw` keeps it as one string (without it multi-line comes back as an array).

- **Image** — save to a PNG in the session scratchpad, then `Read` it:
  ```powershell
  $img = Get-Clipboard -Format Image
  if ($img) { $img.Save('<OUT>', [System.Drawing.Imaging.ImageFormat]::Png); '<OUT>' }
  else { 'no image on clipboard' }
  ```
  Windows PowerShell 5.1 runs STA by default, so `Get-Clipboard -Format Image` works directly. If it ever returns nothing for an image you can clearly see is copied, retry once with `[System.Windows.Forms.Clipboard]::GetImage()` (needs `Add-Type -AssemblyName System.Windows.Forms`).

- **Copied files** (user did Ctrl+C on files in Explorer):
  ```powershell
  Get-Clipboard -Format FileDropList
  ```
  Returns full paths — then `Read` / operate on them directly.

## Write

- **Text**:
  ```powershell
  Set-Clipboard -Value 'the text to put on the clipboard'
  ```
  For multi-line, pass a here-string. For long/awkward content, write it to a temp file first and `Set-Clipboard -Value (Get-Content -Raw file)`.

## Notes
- Windows-only; needs an interactive session (the clipboard is per-session).
- When you write to the clipboard, tell the user briefly what you put there so a paste isn't a surprise.
- Don't silently overwrite the clipboard as a side effect of unrelated work — only when asked or when it's the obvious deliverable.
