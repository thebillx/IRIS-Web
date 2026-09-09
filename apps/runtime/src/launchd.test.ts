import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { LAUNCH_AGENT_LABEL, renderLaunchAgent } from './launchd.js';

describe('IRIS LaunchAgent artifact', () => {
  it('contains only non-secret process configuration', () => {
    const plist = renderLaunchAgent('/Users/example/Library/Application Support/IRIS', '/usr/bin/node', '/Users/example/iris/apps/runtime/dist/control.js');
    expect(plist).toContain(`<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>supervisor</string>');
    expect(plist).toContain('IRIS_RUNTIME_DATA_ROOT');
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain(`${os.homedir()}/.local/bin`);
    expect(plist).not.toContain('Authorization');
    expect(plist).not.toContain('api_key');
    expect(plist).not.toContain('Bearer');
  });
});
