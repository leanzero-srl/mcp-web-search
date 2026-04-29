# Handoff: web-search MCP server changes affecting CogniRunner

> **Positioning note:** the integration pattern below is **generic**. Any
> Atlassian Forge app (or any other sandboxed host that can do HTTPS to
> Tailscale Funnel) can reach this MCP server via a self-hosted LM Studio
> bridge — see the new `## 🧩 Using This MCP From an Atlassian Forge App`
> section in the MCP server's README.md. **CogniRunner is the production
> reference implementation**, not the only supported consumer. The advice
> below applies first-class to CogniRunner; replicate the pattern for any
> other Forge app.

You are working on the **CogniRunner** Forge app at
`/Users/mihaiperdum/Projects/CogniRunner`. A sibling project — the
`web-search` MCP server at `/Users/mihaiperdum/Projects/mcp-web-search-upd/mcp-web-search`
— recently shipped two rounds of changes. CogniRunner references this MCP by
label `"web-search"` in its `SUPPORTED_MCPS` registry (`src/index.js:2309-2312`)
and routes 4 specific tools through it via LM Studio's `integrations` array.
The chain is `Forge → LM Studio (over Tailscale Funnel) → MCP server (stdio)` —
CogniRunner never talks to the MCP server directly.

## What changed in the MCP server

### Round 1 — performance + security (already shipped, commit `b1337d2`)

- **SSRF guard** rejects loopback / RFC1918 / link-local / cloud-metadata
  before any fetch. Verified by 9 hermetic unit tests.
- **Singleton `BrowserPool`** shared across `SearchEngine`,
  `EnhancedContentExtractor`, and `PdfExtractor` (was 3 competing pools).
- **`cleanText` no longer strips vocabulary words** ("photo", "privacy",
  "terms", "cookie", "carousel", "image", "gallery", "copyright", etc.) —
  articles came back mangled before. Verified by 19 hermetic unit tests.
- Pooled browsers are no longer destroyed on every search.
- Default `MAX_CONTENT_LENGTH` lowered from **500 KB → 100 KB** per page.
- Bounded extraction concurrency (`EXTRACT_CONCURRENCY`, default 3).
- Serper circuit breaker (5 failures → 30 s cooldown → half-open probe).
- Per-tool wall-clock budgets capped ≤ 20 s so the
  Forge → LM Studio → MCP chain fits inside Forge's 25 s function timeout.
- `pRetry` jittered exponential backoff replacing linear retry.
- `RateLimiter` queues with bounded wait instead of immediate throw.
- GitHub raw-content path now honors `GITHUB_TOKEN` (60 → 5000 req/hr).
- `USE_SERPER_ONLY=true` is the documented and enforced default.
- Stdio-safe JSON logger replaces global `console.log/error` reassignment.
- `AuditLogger` default-on; gate via `DISABLE_AUDIT_LOG=true`.

### Round 2 — tool audit + LM-Studio compatibility

- New `src/client-detect.ts` reads `getClientVersion()` after the
  `initialize` handshake and exposes `isAgenticClient()` to all tool
  handlers. Whitelist: `claude-ai`, `claude.ai`, `claude-desktop`,
  `claude desktop`, `cline`, `roo code`, `roo-cline`, `continue`. Anything
  else (LM Studio, unknown clients) is treated as **non-agent**.
- Three tools that previously wrote to disk and returned only file paths
  now embed content inline when the caller is non-agentic:
  - `research_and_save_to_markdown` — for non-agent clients, embeds the
    per-URL markdown (capped to fit `MAX_OUTPUT_LENGTH`).
  - `get-openapi-spec` — for non-agent clients, embeds the spec content
    inline (truncated to `OPENAPI_INLINE_CAP`, default 50 KB). Now uses
    `js-yaml` for real YAML parsing — previously YAML specs were silently
    truncated to a 1000-char preview wrapper, returning effectively no
    metadata.
  - `list-cached-documents` — now also enumerates research markdown files
    (was OpenAPI-only, despite the description claiming otherwise).
  - **New tool `read-cached-document(fileName, maxBytes?)`** — pairs with
    `list-cached-documents` to fetch a file's contents inline. Refuses any
    `fileName` containing `/`, `\`, or `..`. This is what makes the listing
    actionable for LM Studio.
- **Tool consolidation** — surface reduced from 13 → 11 tools by removing
  redundant entries:
  - `cached-web-search` removed (the semantic cache is already in
    `full-web-search`'s path; the separate tool just confused small
    models).
  - `filter-sitemap-urls` folded into `get-website-sitemap` as optional
    `keywords?: string[]` and `extractTopMatching?: number` (which also
    runs the extractor on the top N matches in the same call).
  - `get-github-directory-contents` folded into `get-github-repo-content`
    as `mode: 'crawl' | 'list' | 'file'` with optional `path` and
    `previewLength`.
- `get-github-repo-content` exposes `previewLength` (default 500, max
  5000) so the per-file preview cap is no longer hard-coded.
- Dead code removed: `extractTechnicalDoc`, `_extractOpenAPISpecInternal`,
  the unused `expandSingleWordQueries` config, and several stale
  unused-variable lints.
- All 26 pre-existing ESLint errors cleared (now 0 errors;
  `no-console` warnings remain at warn level intentionally).
- New `npm run test:unit` script with 49 hermetic tests covering SSRF,
  cleanText, client detection, and YAML parsing. CI now runs these on
  every push.

## Net impact on CogniRunner

CogniRunner's `SUPPORTED_MCPS.webSearch.allowedTools` are:
`get-web-search-summaries`, `full-web-search`, `get-single-web-page-content`,
`get-pdf-content`. **None** of these tools changed argument shape or return
shape. The only changes that reach CogniRunner are improvements:

| Change | CogniRunner effect |
|---|---|
| Default `MAX_CONTENT_LENGTH` 500 KB → 100 KB | `full-web-search` now returns ~5× less text per result. Frees ~4 MB of context budget per 10-result search. |
| Serper-first default + circuit breaker | Web-search latency drops; on Serper outages, fast-fail to fallback. |
| `cleanText` no longer strips vocabulary | Better extracted content quality for any topic involving words like "photo", "privacy", "terms", "cookie", "image", "gallery", "copyright" — previously these were stripped from response bodies. |
| Per-tool ≤ 20 s budget | Web-search calls now hard-cap below CogniRunner's own 22 s agentic deadline; no surprise hangs. |
| Singleton browser pool + bounded concurrency | Cold-start ~1–3 s faster on browser-fallback paths. |

**Required code changes in CogniRunner: none.** Tool names, arguments,
return shapes are unchanged for the 4 tools you allowlist.

### About the new client-aware branching (and why it's safe for both sides)

The MCP server now reads the calling client's identity at the `initialize`
handshake (`getClientVersion()?.name`) and adapts behavior of three
disk-write tools (`research_and_save_to_markdown`, `get-openapi-spec`, the
new `read-cached-document`'s sibling `list-cached-documents`):

- **Agentic clients** (Cline / Claude Desktop / Roo Code / Continue /
  claude-ai) keep the original behavior: response contains compact
  metadata + a file path. They have a sibling filesystem MCP and read
  the file themselves.
- **Non-agent clients** (LM Studio, anything not on the whitelist) get
  the same metadata **plus** the content embedded inline (truncated to
  fit `MAX_OUTPUT_LENGTH`). The disk write still happens as a side
  effect.

End-to-end smoke verifying the decision (run from the MCP repo):

```
$ bash /tmp/mcp-call-as.sh "Cline"     "get-openapi-spec" '{"url":"https://petstore.swagger.io/v2/swagger.json","forceRefresh":true}'
response length: 788 chars       embeds inline: false   isError: false

$ bash /tmp/mcp-call-as.sh "lm-studio" "get-openapi-spec" '{"url":"https://petstore.swagger.io/v2/swagger.json","forceRefresh":true}'
response length: ~26 KB chars    embeds inline: true    isError: false
```

Same tool, same URL, same arguments. The only thing that changed is
`clientInfo.name`. **CogniRunner runs through LM Studio, so it always lands
on the non-agent path** — full content embedded inline, no need for a
filesystem MCP downstream of LM Studio. (LM Studio itself uses stdio to
talk to this MCP and just pipes the response text back through.)

## Recommended (optional) updates in CogniRunner

These are polish items — none are gating.

1. **Refresh the web-search guidance string** at
   `CogniRunner/src/index.js:2312`. The current text says
   *"Web search is slow (30–90 s); budget at most 1 call per validation"*.
   Updated reality: typical full-web-search is **6–12 s on cache miss,
   < 200 ms on cache hit**. Suggested replacement:

   > "Use to verify factual claims or fetch URL content the prompt explicitly
   > references. Sub-tool priority (cheapest first): `get-web-search-summaries`
   > for quick fact checks → `get-single-web-page-content` only when the prompt
   > names a specific URL → `get-pdf-content` ONLY for `.pdf` URLs (not HTML
   > pages that mention PDFs) → `full-web-search` only when summaries are
   > insufficient. Typical latency: 6–12 s on cache miss, < 200 ms on cache
   > hit. Budget at most 1 call per validation unless the prompt explicitly
   > demands more."

2. **Update the LM Studio `mcp.json` snippet** shown in your admin-panel setup
   UI to surface the new tunables. Recommended block:

   ```json
   {
     "mcpServers": {
       "web-search": {
         "command": "node",
         "args": ["/ABSOLUTE/PATH/TO/mcp-web-search/dist/index.js"],
         "env": {
           "SERPER_API_KEY": "<key>",
           "USE_SERPER_ONLY": "true",
           "MAX_CONTENT_LENGTH": "100000",
           "EXTRACT_CONCURRENCY": "3",
           "GITHUB_TOKEN": "<optional pat>",
           "SERPER_BREAKER_FAILURES": "5",
           "SERPER_BREAKER_COOLDOWN_MS": "30000"
         }
       }
     }
   }
   ```

3. **No allowlist change needed.** `cached-web-search` was not in your
   allowlist, so its removal is invisible. The 4 tools you use are unchanged.

4. **Verify with `pingLmStudioMcp`.** After users update their `mcp.json`,
   the existing ping resolver (`CogniRunner/src/index.js:2380`) confirms the
   `mcp/web-search` plugin loads. No code change there.

5. **Optional latency budget tweak.** If you previously calibrated the
   agentic 22 s deadline against the slower MCP, you now have ~6–10 s of
   headroom you could spend on an extra tool round. Or leave the budget
   untouched for safety margin.

## Things you should NOT do

- Do not switch your provider away from `lmstudio` to talk to the MCP
  server directly — there is no HTTP transport on the MCP server, and the
  decision was deliberate (Forge talks to LM Studio; LM Studio talks to MCP).
- Do not rename the MCP integration label. CogniRunner expects the literal
  string `"web-search"` and the user's `mcp.json` must use the same key.
- Do not pass `*.local`, `localhost`, RFC1918, or `[::1]` URLs to
  `get-single-web-page-content` or `get-pdf-content` — the new SSRF guard
  rejects them. Use Tailscale Funnel (`*.ts.net`) for any private targets,
  which the SSRF guard correctly permits because Funnel addresses resolve
  to public Tailscale relay IPs.

## Verification checklist

After applying the optional updates:

- [ ] Admin panel `mcp.json` snippet matches the current MCP server defaults.
- [ ] `pingLmStudioMcp` for `webSearch` returns success.
- [ ] Run an agentic validator that hits web-search; confirm latency is in
      the 6–12 s range on cache miss, < 200 ms on cache hit.
- [ ] No `Refused to fetch private/reserved address` errors in execution
      logs (would indicate someone passed a localhost URL — should not
      happen via Tailscale Funnel).

## Reference: where to look

| What | File |
|---|---|
| MCP server changes overview | `mcp-web-search/README.md` |
| Per-tool implementations | `mcp-web-search/src/server.ts` |
| Client detection | `mcp-web-search/src/client-detect.ts` |
| Hermetic unit tests | `mcp-web-search/tests/unit/*.test.ts` |
| CogniRunner web-search registry | `CogniRunner/src/index.js:2289-2319` |
| CogniRunner LM Studio inference path | `CogniRunner/src/index.js:4197-4279` |
| MCP ping resolver | `CogniRunner/src/index.js:2380` |
