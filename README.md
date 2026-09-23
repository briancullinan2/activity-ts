
# Activity

> **Repository Overview**: A unified single-file web deployment (`index.html`), personal live dashboard, real-time spatial map, self-hosted tool aggregator, and generative AI research collection.

---

## Technical Stack & Architecture

- **Frontend Core**: Custom single-file HTML/CSS web application leveraging CSS-only input routing (`input[type="radio"]` tab navigation, CSS selectors for view switching).
- **Spatial Engine & Mapping**: Leaflet.js with Carto dark basemaps, custom OSRM road-snapping route processing, and dynamic waypoint clustering (`#map` tile rendering and direction-arrow markers).
- **Client-Side Storage & Indexing**: Browser-based File System Access API, IndexedDB persistence, OPFS SQLite, and local thread tracking via `briancullinan2/mediaserver`.
- **In-Browser Compute & AI**: WebGPU integration, WebLLM / MLC-LLM (`mlc-ai/web-llm`), ONNX Runtime Web, and Stable Diffusion browser execution.
- **Hardware Integration**: Raspberry Pi 5 monitoring interfaces, local CCTV / video streaming keyframe offsets, and Cloudflare Tunnel (`cloudflared`) remote connectivity.

---

## Active & Past Software Projects


```

+-----------------------------------------------------------------------------------+
| Project Name       | Core Technologies & Architecture                             |
+--------------------+--------------------------------------------------------------+
| Illustrious        | Client-side Web IDE, 3D spatial engine, WebAssembly C,      |
|                    | Lumino dock layouts, Ace editor workers, nuNuStudio, xterm.js|
+--------------------+--------------------------------------------------------------+
| StudySauce / Atrium| Educational flashcard platform, C#, Blazor Hybrid, .NET MAUI,|
|                    | Entity Framework Core, SQLite, background synchronization    |
+--------------------+--------------------------------------------------------------+
| Quake3e WASM       | Low-level Clang compilation to WebAssembly using WASI-SDK,   |
|                    | q3lcc/q3asm build pipelines, browser-based Quake III Arena   |
+--------------------+--------------------------------------------------------------+
| Live Resume        | Single-file live development dashboard, monitor feed embeds, |
|                    | Leaflet GPS route hub, interactive categorizations           |
+--------------------+--------------------------------------------------------------+
| Jupyter Ops        | Local ops automation pipelines, model parameter generation,  |
|                    | local AI execution interfaces                                |
+--------------------+--------------------------------------------------------------+

```

---

## Platform Components

### 1. Interactive Navigation & Dashboard Interfaces

- **Home**: Core bio, title, location verification, primary contact info, and site objectives.
- **Federal Resume**: Printable, formatted work history and compliance documents.
- **Brian Chat**: Self-hosted chat endpoint and agent execution interface.
- **Live Development**: Real-time display monitor feeds (`monitors/0`, `monitors/1`, `monitors/2`) and streaming status overlays.
- **Timeline Route Hub**: Leaflet spatial rendering engine processing latitude/longitude waypoints, trace pathways, and location pings over Carto dark tiles.

---

### 2. Research & Study Interests Bookmark Index

Categorized bookmark directories indexed directly into the site runtime:


```

[Study Interests Index]
├── Computer Science
│   ├── mlc-ai/web-llm & web-llm-chat (In-browser LLM Inference)
│   ├── Input Leap (Open-source KVM software)
│   ├── Proxmox on Raspberry Pi (ARM64 PVE builds)
│   ├── Web3-Pi UPS & Power Supplies (Hardware power management)
│   ├── Overbounce (Quake III Arena movement physics port)
│   ├── Stirling-PDF & Actual Budget (Local-first self-hosted tools)
│   └── Trilium Notes & Mind Elixir (Knowledge base structures)
├── Engineering
│   ├── ESP32 & LoRa Off-Grid Texting
│   ├── MetMo Fractal Vise & Hardware Prototyping
│   └── goBILDA & Mouser Component Architecture
├── Law/Legal
│   ├── Regulatory compliance, Arizona statutory legal codes
│   └── Public record verifications (LexisNexis / Accurint data structures)
├── Medical Science
│   └── Neurological structures, hallucinogenic & therapeutic LSD molecular bindings
└── Education
└── Online curriculum models and distance learning platforms

```

---

### 3. Clip Art & Generative Image Categories

Prompt structures and image libraries generated via local Stable Diffusion deployments:

- **Style Prompts**: Anime/Manga, Robotic, Steampunk, Retro 80s, Fantasy Art, Pop Art, Gothic, Cyberpunk.
- **Subject Categories**: Animals, Places, Scenes, Patterns, Holidays, Mythology, Cosmic, Buildings, Other.
- **Mythology & History**: Greek God robots, Stations of the Cross, Bible scene variations, Saint iconography.

---

### 4. Brainstorming & Research Frameworks

Structured mental models, architectural notes, and cognitive exercises:

- **Genesis Framework**: 7-day cyclical schedule structuring daily cognitive focuses (Light/Knowledge, Atmosphere/Breathing, Land/Plants, Sun/Stars, Birds/Sea, Animals/People, Sabbath/Rest).
- **Spatial Memory Expansion**: Exercises for mapping geographic routes, emotional associations, and structural recall from childhood and physical environments.
- **Trance & Meditation Protocols**: Fasting, physical isolation, sensory dampening, and acoustic oscillation routines for altered brainwave states.
- **Signs & Pattern Recognition**: Behavioral observations, environmental feedback loops, and theta-state awareness.
- **Dreamwork & Powernaps**: Methods for leveraging hypnagogic and theta-wave states for creative problem-solving and rapid prototyping.

---

### 5. Creative Writing & Documentation Library

Integrated Google Docs repository for theoretical research and narratives:


```

+--------------------------+--------------------------------------------------------+
| Document Title           | Subject / Focus                                        |
+--------------------------+--------------------------------------------------------+
| Messages from Tannhauser | Sci-Fi Narrative & Theoretical Physics                 |
| Portals in Awen          | Metaphysical / Conceptual Worldbuilding                |
| Convergence Theory       | Information Theory & Structural Evolution              |
| EEG Grant Proposal       | Brainwave Telemetry & Hardware Interface Design        |
| Quantum Landscaping      | Spatial Processing & Reality Mechanics                 |
| AI Governance            | Safety Standards, Autonomous Ethics, Regulatory Frameworks|
| Believing vs Knowing     | Epistemology & Cognitive Systems Architecture          |
+--------------------------+--------------------------------------------------------+

```

---

### 6. Logged Activity & Daily Activity Timeline

- **Browsing History**: Timestamped web requests tracking technical research, GitHub repositories, hardware vendors, and local Arizona news.
- **Daily Activity Log**: Subjective logs, dream recordings, personal thoughts, and emotional/cognitive telemetry categorized by topic tags (*General, Iga, Robot_do, Revelation, Predictions, Diet, Emotions*).

---

## Deployment & Execution Instructions

1. **Local Serving**:
   - Serve the root directory using any zero-configuration HTTP server (e.g., `python3 -m http.server 8000` or `npx serve`).
   - Open `index.html` in any modern WebGPU-enabled web browser.

2. **Map Dependencies**:
   - Requires external network access to `c.basemaps.cartocdn.com` and `a.basemaps.cartocdn.com` for dark tile fetching, along with Leaflet CSS/JS assets.

3. **Monitor Feeds**:
   - Monitor feeds load dynamically from local/tunnel endpoints (`https://brian-chat.pryor.games/monitors/*`) via JavaScript image re-requests.

