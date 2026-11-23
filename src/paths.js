import { join } from 'node:path';

export function paths(env = process.env) {
  const home = env.HOME;
  const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'termbrowse');
  const state = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'termbrowse');
  const cache = join(env.XDG_CACHE_HOME || join(home, '.cache'), 'termbrowse');
  return {
    config: join(config, 'config.toml'),
    state,
    cache,
    registry: join(state, 'agents.json'),
    profiles: join(state, 'profiles'),
    starter: join(state, 'starter-profile'),
    logs: join(state, 'logs'),
  };
}
