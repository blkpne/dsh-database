import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Boot from '@deepseek-ai/dsh-app-boot';

const require = createRequire(import.meta.url);
const pkg = require('dsh-database/package.json');
const runtime = Boot.getDshRuntimeVersion();
assert.equal(Boot.evaluatePluginCompatibility(pkg, {}, runtime), undefined);
// Regression: accepting a later host must not require a new plugin manifest.
for (const version of ['0.3.0-alpha.1', '0.3.0', '1.0.0', '2.0.0-rc.1'])
  assert.equal(Boot.evaluatePluginCompatibility(pkg, {}, version), undefined, version);
// Older hosts only inspect peers. Probe this capability before testing the engine lower bound.
const engineProbe = { ...pkg, engines: { ...pkg.engines, dsh: '<0.0.0-0' } };
if (Boot.evaluatePluginCompatibility(engineProbe, {}, runtime)?.requirements?.['engines.dsh']) {
  assert(Boot.evaluatePluginCompatibility(pkg, {}, '0.2.0-rc.1'));
  console.log(
    `Official DSH ${runtime} gate: current/future manifests accepted; below-minimum rejected.`,
  );
} else {
  console.log(
    `Official DSH ${runtime} legacy peer gate: current/future manifests accepted; engines.dsh is not enforced by this host.`,
  );
}
