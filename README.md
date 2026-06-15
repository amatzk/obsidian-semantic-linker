
# Obsidian SemVink

Obsidian plugin for semantic search and discovering similar notes using Ollama.

> **Note**: This plugin is not published in the Community Plugins directory. Manual installation only.

## Features

- **Similar Notes**: Discover related notes in sidebar or inline view
- **Semantic Search**: Find notes by meaning, not just keywords

## Installation

### Prerequisites

1. Install Ollama from [ollama.com](https://ollama.com)
2. Pull an embedding model

### Plugin Installation

1. Download `main.js`, `manifest.json`, `styles.css` from releases
2. Copy to `<vault>/.obsidian/plugins/semvink/`
3. Enable in Obsidian settings

## Usage

1. Configure Ollama URL and model in plugin settings
2. Run command: "Run Full Indexing"
3. Open sidebar with sparkles icon or use "SemVink" command

## Development

```bash
pnpm install
pnpm run dev        # Watch mode
pnpm run build      # Production build
pnpm run lint       # Check code
```
