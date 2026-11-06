import assert from 'node:assert/strict';
import semver from 'semver';

export function hostSelector(selector, plugin) {
  if (selector === 'minimum') {
    const minimum = semver.minVersion(plugin.engines.dsh);
    assert(minimum, 'engines.dsh must declare a minimum supported host');
    return minimum.version;
  }
  assert(
    selector === 'latest' || semver.valid(selector),
    'Use minimum, latest or an exact DSH version',
  );
  return selector;
}

// DSH packages share the main release version; independent libraries follow its manifest.
export function hostPackageSpecs(plugin, host) {
  assert(semver.valid(host.version), 'The DSH main package must resolve to one exact version');
  assert(semver.satisfies(host.version, plugin.engines.dsh, { includePrerelease: true }));
  return [
    `@deepseek-ai/dsh@${host.version}`,
    // The smoke imports this provider directly for the executor-based tools API.
    // Do not require it from older hosts, where native execution is built in.
    ...(semver.gte(host.version, '0.2.2-rc.1')
      ? [`@deepseek-ai/dsh-tool-executor-native@${host.version}`]
      : []),
    // Current-only development providers must not become requirements on older hosts.
    ...Object.keys(plugin.peerDependencies)
      .filter((name) => name.startsWith('@deepseek-ai/'))
      .map((name) => {
        const version = name.startsWith('@deepseek-ai/dsh-')
          ? host.version
          : host.dependencies[name];
        assert(version, `DSH ${host.version} does not declare ${name}`);
        return `${name}@${version}`;
      }),
  ];
}
