# Internal API

The desktop app has no network API. The UI talks to the main process only through the typed contract in `desktop/src/shared/api.ts`: `EchoApi` lists every method, and `EchoEvents` lists every event pushed to the UI.

Calls to external AI services happen only in the main process, through `desktop/src/main/ai/`.

The optional self-hosted REST API from prompt §20 (Server mode) is planned after desktop and Android. It will be documented here when it exists.
