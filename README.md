# Handwave VS Code Extension

This repository contains a first prototype of a VS Code extension for browsing
Handwave articles and Lean declarations as one lightweight semantic graph.

The extension indexes ordinary `.lean` files and provisional Handwave article
files (`.hw.md` and `.hw`), validates links and transclusions, and renders
article previews in a read-only webview.

## Development

```sh
npm install
npm run compile
npm test
```

Use `Handwave: Rebuild Index`, `Handwave: Open Article Preview`, and
`Handwave: Show Backlinks` from the VS Code command palette.
