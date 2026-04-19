# Memory Assist Calibration Runbook

Use this runbook to generate fresh `memory assist` calibration data without
introducing project-specific or personal data into the repo.

## Primary entrypoint

Prefer the automated live validation script first:

```bash
npm run memory-assist:validate
```

If the worker is not already healthy or the bundle is stale, let the script
prepare the runtime first:

```bash
npm run memory-assist:validate -- --prepare
```

The script drives the real `hook raw` path against the live worker and checks
the resulting `/api/memory-assist/stats` and `/api/memory-assist/decisions`
payloads. Use the manual loop below only when you need to debug why the script
failed.

## Goals

Generate a small live sample that produces all of these within the last 30 days:

- one `semantic_prompt` inject;
- one `semantic_prompt` skip due to `below_threshold`;
- one `file_context` inject;
- one `likely_helped` verdict with exact observation linkage;
- one non-empty `shadowRanking` block in the viewer.

## Preconditions

1. The worker is healthy:

   ```bash
   curl http://127.0.0.1:37777/health
   ```

2. The plugin bundle is current:

   ```bash
   npm run build
   node scripts/sync-marketplace.cjs --force
   bun plugin/scripts/worker-service.cjs stop
   bun plugin/scripts/worker-service.cjs --daemon
   ```

3. Semantic prompt assist is enabled in `~/.claude-mem/settings.json`:

   - `CLAUDE_MEM_SEMANTIC_INJECT=true`
   - `CLAUDE_MEM_SEMANTIC_INJECT_LIMIT=3`
   - `CLAUDE_MEM_SEMANTIC_INJECT_THRESHOLD=0.35`

## Manual validation loop

Run these steps in a neutral scratch project with synthetic files and prompts.
Do not use customer paths, secrets, or personal notes.

### 1. Seed file memory

Create a tiny scratch repo with neutral files such as:

- `src/example/service.ts`
- `src/example/formatter.ts`
- `src/example/notes.md`

Then perform a short session that:

1. reads `service.ts`;
2. edits `service.ts`;
3. reads it again;
4. ends cleanly.

This should create file-linked observations and give the judge a
`read -> edit/write` sequence to evaluate.

### 2. Trigger prompt memory

Start a fresh prompt in the same scratch repo that refers to the same synthetic
concepts, for example:

```text
Reuse the timeout handling pattern from the service helper and keep the public
API shape unchanged.
```

This should produce a `semantic_prompt` decision and populate `shadowRanking`.

### 3. Trigger a conservative skip

Run a very short or generic prompt such as:

```text
continue
```

or a prompt that should be under threshold. This should create a skipped
`semantic_prompt` decision, ideally with `below_threshold` or `query_too_short`.

### 4. Verify in the viewer

Open the viewer and confirm:

- `Memory assist` shows recent 30d activity;
- `Trace what was used` opens on the latest help;
- `Calibration` shows:
  - inject rate;
  - likely-helped rate;
  - user-confirmed helpful rate;
  - shadow ranking stats;
  - a threshold recommendation.

### 5. Verify via API

```bash
curl 'http://127.0.0.1:37777/api/memory-assist/stats?days=30'
curl 'http://127.0.0.1:37777/api/memory-assist/decisions?limit=20&days=30'
```

Check for:

- `shadowRanking.totalCompared > 0`
- at least one `systemVerdict=likely_helped`
- at least one decision with `signalSource=exact_observation_link`
- at least one skipped `semantic_prompt`

## Notes

- The goal is calibration data, not model quality.
- Keep prompts/files synthetic and reusable.
- If `shadowRanking` remains empty, the semantic recall path did not execute in
  that session and the run should be repeated with a clearer concept-overlap
  prompt.
