import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function verifyDesktopInputs(root) {
  const modules = path.join(root, 'node_modules');
  if (lstatSync(modules).isSymbolicLink()) throw new Error('Desktop packaging requires a physical node_modules directory, not a symlink or Windows Junction.');
  const args = ['list', '-a', '--include', 'prod', '--include', 'optional', '--omit', 'dev', '--json', '--long', '--silent', '--loglevel=error'];
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('The production dependency graph is incomplete. Restore dependencies in a physical directory before packaging.');
  const tree = JSON.parse(result.stdout);
  if (tree.problems?.length) throw new Error('npm reported production dependency problems; packaging stopped.');
}

export function verifyDesktopPackage(appRoot) {
  const root = realpathSync(appRoot);
  const within = target => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
  for (const file of ['desktop/main.mjs', 'server/app.mjs', 'server/mcp.mjs', 'dist/index.html', 'plugins/paperdesk/scripts/start.mjs', 'plugins/paperdesk/ui/reader.html']) {
    if (!existsSync(path.join(root, file))) throw new Error(`Desktop package is missing ${file}`);
  }
  const visited = new Set();
  function inspect(directory) {
    const actual = realpathSync(directory);
    if (!within(actual)) throw new Error('A packaged dependency resolves outside the application.');
    if (visited.has(actual)) return;
    visited.add(actual);
    const manifest = JSON.parse(readFileSync(path.join(actual, 'package.json'), 'utf8'));
    const optional = manifest.optionalDependencies || {};
    const requiredPeers = Object.fromEntries(Object.entries(manifest.peerDependencies || {}).filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional));
    for (const name of new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(optional), ...Object.keys(requiredPeers)])) {
      let current = actual, found;
      while (within(current)) {
        const candidate = path.join(current, 'node_modules', name);
        if (existsSync(path.join(candidate, 'package.json'))) { found = candidate; break; }
        if (current === root) break;
        current = path.dirname(current);
      }
      if (found) inspect(found);
      else if (!Object.hasOwn(optional, name)) throw new Error(`Desktop package is missing ${name}, required by ${manifest.name}.`);
    }
  }
  inspect(root);
  return { verifiedPackages: visited.size, readerResourceIncluded: true };
}
