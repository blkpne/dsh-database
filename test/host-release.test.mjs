import test from 'node:test';
import assert from 'node:assert/strict';
import { hostPackageSpecs, hostSelector } from '../scripts/host-release.mjs';

const plugin = {
  engines: { dsh: '>=0.2.0-rc.2' },
  peerDependencies: {
    '@deepseek-ai/dsh-tools': '*',
    '@deepseek-ai/cordis': '~4.0.4',
  },
  devDependencies: { '@deepseek-ai/dsh-working-directory': '0.2.1-rc.2' },
};

test('host matrix follows the main release, including independent library versions', () => {
  assert.equal(hostSelector('minimum', plugin), '0.2.0-rc.2');
  assert.equal(hostSelector('latest', plugin), 'latest');
  assert.equal(hostSelector('1.0.0-rc.1', plugin), '1.0.0-rc.1');
  assert.deepEqual(
    hostPackageSpecs(plugin, {
      version: '0.3.0-rc.1',
      dependencies: { '@deepseek-ai/cordis': '~4.1.0' },
    }),
    [
      '@deepseek-ai/dsh@0.3.0-rc.1',
      '@deepseek-ai/dsh-tools@0.3.0-rc.1',
      '@deepseek-ai/cordis@~4.1.0',
    ],
  );
});

test('host matrix refuses missing, mixed or unsupported release metadata', () => {
  assert.throws(() => hostSelector('^0.2.0', plugin));
  assert.throws(() => hostPackageSpecs(plugin, { version: 'latest', dependencies: {} }));
  assert.throws(() => hostPackageSpecs(plugin, { version: '0.1.0', dependencies: {} }));
  assert.throws(
    () => hostPackageSpecs(plugin, { version: '0.2.1-rc.2', dependencies: {} }),
    /cordis/,
  );
});
