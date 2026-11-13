// Codex hook events (the "live" part of the Codex source): the hook script sends the event's stdin to
// POST /api/codex/events and the route passes it on here. The Codex source (sources/codex/source.ts) implements it.

export interface CodexLive {
  /**
   * Applies a Codex hook event (its stdin: `hook_event_name`, `session_id`, `agent_id`, `cwd`,
   * `tool_name`, `tool_use_id`, `tool_input`, `transcript_path`...) to the office. `account` = Codex account of
   * whoever sent it (account id or the CODEX_HOME folder; absent = deduced from the `transcript_path` or the thread).
   * Returns false for an unknown event or a session that matches no Codex account.
   */
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}
