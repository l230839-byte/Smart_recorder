# Free stack

EchoMind uses free and open-source software only. `npm run check:licenses` fails the build if a production dependency is GPL, AGPL, or has an unknown licence.

## Runtime dependencies

| Component | Purpose | Licence |
| --- | --- | --- |
| Electron | App runtime (includes Chromium and Node) | MIT |
| React | UI | MIT |
| Mediabunny | Media probing, demuxing, muxing and conversion | MPL-2.0 (file-level copyleft; no effect on app code) |
| lucide-react | Icons | ISC |
| Inter (via Fontsource) | Typeface | SIL OFL 1.1 |

## AI providers

None are connected yet. Phase 3 adds a fake provider, then real free-tier providers using your own key. Before coding them, their current free terms and limits will be checked against official documentation and recorded here. Limits are kept in configuration, never hardcoded.
