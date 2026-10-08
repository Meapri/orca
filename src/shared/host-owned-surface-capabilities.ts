// Capabilities for surfaces a host owns without a renderer: closed-surface retirement and editor tabs.

// Why: names the host-authority contract in docs/reference/multi-client-state-authority.md — this
// host durably refuses creates/adoptions at tab or leaf ids a committed close retired (answering
// `TERMINAL_SURFACE_RETIRED_ERROR`, which older clients read as terminal-gone) and will not spawn a
// second resume of an agent session that already has a live pane.
export const TERMINAL_CLOSED_SURFACE_LEDGER_RUNTIME_CAPABILITY =
  'terminal.closed-surface-ledger.v1' as const
// Why: a headless host (orcad, `orca serve`) refuses files.open/openDiff with renderer_unavailable
// and released phones fall back to device screens on that code. A client advertising this accepts
// a host-owned editor tab instead: it arrives over session.tabs and is read via markdown.readTab.
export const SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY =
  'session-tabs.host-editor-tabs.v1' as const
