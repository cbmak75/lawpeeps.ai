/**
 * editor.mjs -- Editorial Orchestrator
 *
 * The brain of mm!ke. Runs the full editorial cycle:
 *   1. Monitor (RSS feeds + tip line)
 *   2. Discover (web search for what feeds missed)
 *   3. Research (deep dive on candidates)
 *   4. Write (draft articles with mm!ke's voice)
 *   5. Verify (structured claim validation)
 *   6. Stage (create PRs with green/amber/red classification)
 *   7. Reflect (update memory, positions, knowledge)
 *
 * Run: node agents/editor.mjs
 * Expects: ANTHROPIC_API_KEY, GITHUB_TOKEN
 #•à‰