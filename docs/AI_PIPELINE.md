# AI pipeline

Not built yet. Phase 3 starts it. The planned flow from prompt §18 is:

```text
Native recording, import, video ─▶ Ingestion ─▶ Library ─▶ Transcription ─▶ Transcript storage and index
                                                                              │
                         Knowledge library ◀─ Output engine ◀─ AI processing ◀┘
```

Every input source joins at ingestion, so nothing downstream depends on where audio came from.
