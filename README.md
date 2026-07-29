# Goku File Explorer

**A modern file explorer for designers and 3D artists**

![Platform](https://img.shields.io/badge/Platform-Windows-blue)
![Version](https://img.shields.io/badge/Version-1.0.3%20Beta-green)
![License](https://img.shields.io/badge/License-MIT-purple)

---

## About

Goku File Explorer is a Windows Explorer replacement built for **designers** and **3D artists**. It features a Windows 11-style interface with powerful file preview capabilities for images, videos, 3D models, EXR sequences, and more.

---

## More Info & Download

**Built by Creators, for Creators**

| Info | Details |
|------|---------|
| Version | Beta 1.0.3 |
| Size | 300 MB |
| Platform | Windows 7+ (x86-64) |

Download: [https://dqa.vn/devapps/](https://dqa.vn/devapps/)

---

## Features

### :file_folder: File Management

- Multi-tab browsing
- Copy/Cut/Paste with keyboard shortcuts
- Drag & Drop from OS
- Delete to Recycle Bin or permanently
- Undo/Redo operations
- Quick navigation palette (Ctrl+K)
- Breadcrumb navigation

### :framed_picture: Preview Support

**Images**

- PNG, JPG, GIF, WebP, TIFF, BMP, TGA, ICO
- PSD files (with layers/channels metadata)
- AI vector files
- EXR HDR images
- Auto-generated thumbnails

**Video**

- MP4, MOV, AVI, MKV, WebM playback
- Audio waveform display
- Transport controls (play, seek, volume)

**3D Models**

- USD/USDA/USDC/USDZ
- glTF/GLB (with Draco)
- FBX, OBJ, STL, PLY
- Alembic (ABC) via WebAssembly

**Documents**

- PDF viewer
- EPUB reader
- Font preview (.ttf, .otf, .woff)
- Code syntax highlighting

### :film_strip: EXR Sequence Player

- Timeline scrubbing
- Auto-playback with FPS control
- Layer and channel selection
- ACES/OCIO color grading
- HDRI detection
- GPU-accelerated caching
- Color eyedropper

### :compass: Navigation

- Quick Access (Recent, Desktop, Documents, Downloads)
- All drives with capacity display
- Cloud storage integration (OneDrive, Google Drive, Dropbox, iCloud)
- Special folders

### :wrench: Tools

- Space Analyzer - Disk usage visualization
- Tags - Label files (Deliverable, WIP, Draft, Archived, Warning)
- Transfer Queue - Queue large copy/move operations
- ZIP Support - Compress and extract archives
- Shell Integration - Windows context menu support
- Open With - Custom application selection

### :art: Customization

- Themes: Dark, Light, Monochrome
- Accent color from system
- Font: Segoe UI or JetBrains Mono
- Font size scaling (80-150%)
- Language: English / Vietnamese

---

## Keyboard Shortcuts

### :keyboard: Navigation

| Shortcut | Action |
|----------|--------|
| Alt + Left/Right | Navigate back/forward |
| Alt + Up | Go to parent folder |
| Ctrl + K | Open palette |
| F5 | Refresh |

### :point_up: Selection

| Shortcut | Action |
|----------|--------|
| Ctrl + A | Select all |
| Ctrl + Click | Multi-select |
| Tab | Switch panels |

### :scissors: File Operations

| Shortcut | Action |
|----------|--------|
| Ctrl + C | Copy |
| Ctrl + X | Cut |
| Ctrl + V | Paste |
| Ctrl + Z | Undo |
| Ctrl + Y | Redo |
| Delete | Move to Recycle Bin |
| Shift + Delete | Permanent delete |

### :gear: Other

| Shortcut | Action |
|----------|--------|
| Ctrl + T | New tab |
| Ctrl + Space | Toggle details pane |
| Ctrl + W | Close inspector |
| Mouse X1/X2 | Back/Forward |

---

## Tech Stack

### :computer: Frontend

- React 19 + TypeScript
- Vite 6
- Tailwind CSS
- Three.js

### :hammer: Backend

- Tauri 2 (Rust)
- Windows APIs
- FFmpeg
- OpenEXR

---

## Project Structure

`
Goku File Explorer/
src/
  components/           React UI components
    ExplorerHeader.tsx
    ExplorerSidebar.tsx
    ExplorerMainPane.tsx
    3DModelViewer.tsx
    VideoPlayerPreview.tsx
    PDFPreview.tsx
    exrPlayerV2/       EXR sequence player
    EwaViewer/         Gaussian splat renderer
    SpaceAnalyzerDashboard.tsx
  hooks/               Custom React hooks
  contexts/            State management
  utils/               Utilities

src-tauri/
  src/
    main.rs            Entry + HTTP server
    openexr_core.rs    OpenEXR decoding
    ewa_decoder.rs     EWA decoding
    fast_image.rs      Fast image loading
    transfer.rs        File operations
    recycle_bin.rs      Recycle bin
  Cargo.toml
  tauri.conf.json

public/
  usd-viewer/          Bundled USD viewer
  wasm/                WebAssembly modules
  draco/               Draco decoder

wasm_src/              WASM source code (C++)
`

---

## File Formats

| Category | Formats |
|----------|---------|
| :bust_in_silhouette: Images | PNG, JPG, GIF, WebP, TIFF, BMP, TGA, ICO, PSD, AI, EXR |
| :film_projector: Video | MP4, MOV, AVI, MKV, WebM, M4V, WMV, FLV |
| :package: 3D | USD, glTF, GLB, FBX, OBJ, STL, PLY, ABC |
| :book: Documents | PDF, EPUB, TXT, MD, HTML, CSS, JS, JSON, XML, YAML |
| :musical_note: Audio | MP3, WAV, FLAC, AAC, OGG, M4A, WMA |
| :file_cabinet: Archives | ZIP, RAR, 7Z, TAR, GZ |
| :capital_abcd: Fonts | TTF, OTF, WOFF, WOFF2, EOT |

---

## License

MIT License

---

Built with [Tauri](https://tauri.app/) | [React](https://react.dev/) | [Three.js](https://threejs.org/)