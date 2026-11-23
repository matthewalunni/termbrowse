// Which agent this MCP process serves: explicit, then the Herdr terminal, then the parent pid.
export function agentId(env = process.env, ppid = process.ppid) {
  return env.TERMBROWSE_AGENT || env.HC_TERMINAL_ID || `pid-${ppid}`;
}
