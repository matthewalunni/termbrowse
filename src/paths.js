import { chmod, mkdir } from 'node:fs/promises';
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

// The state dir holds profiles with cookies, so it is private to the user. chmod as well as
// mkdir: an install from before this existed has it world-readable.
export async function ensureStateDir(p = paths()) {
  await mkdir(p.profiles, { recursive: true, mode: 0o700 });
  await chmod(p.state, 0o700);
  await chmod(p.profiles, 0o700);
}
