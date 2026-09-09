import { describe, expect, it } from 'vitest';
import { LAUNCH_AGENT_LABEL, renderLaunchAgent } from './launchd.js';
import { canonicalNodeRuntime, node24Path } from './node-runtime.js';

describe('IRIS LaunchAgent artifact', () => {
  it('contains only non-secret process configuration', () => {
    const node = canonicalNodeRuntime();
    const plist = renderLaunchAgent('/Users/example/Library/Application Support/IRIS', node.path, '/Users/example/iris/apps/runtime/dist/control.js');
    expect(plist).toContain(`<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>supervisor</string>');
    expect(plist).toContain('IRIS_RUNTIME_DATA_ROOT');
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain(`${node24Path(node.path)}`);
    expect(plist).not.toContain('/.hermes/node/bin');
    expect(plist).not.toContain('Authorization');
    expect(plist).not.toContain('api_key');
    expect(plist).not.toContain('Bearer');
  });
});
