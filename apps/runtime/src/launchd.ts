import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';
import { writePrivateJsonAtomic } from './credentials.js';

const execFileAsync = promisify(execFile);
export const LAUNCH_AGENT_LABEL = 'com.iris.supervisor' as const;

export interface LaunchdPaths {
  readonly directory: string;
  readonly plist: string;
  readonly stdout: string;
  readonly stderr: string;
}

export function launchdPaths(dataRoot: string): LaunchdPaths {
  const directory = path.join(dataRoot, 'launchd');
  return {
    directory,
    plist: path.join(directory, `${LAUNCH_AGENT_LABEL}.plist`),
    stdout: path.join(dataRoot, 'logs', 'supervisor.log'),
    stderr: path.join(dataRoot, 'logs', 'supervisor-error.log'),
  };
}

export function renderLaunchAgent(dataRoot: string, executable: string, controlScript: string, executableArguments: readonly string[] = []): string {
  const paths = launchdPaths(dataRoot);
  const argumentsList = [executable, ...executableArguments, controlScript, 'supervisor'];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(LAUNCH_AGENT_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argumentsList.map((argument) => `    <string>${xml(argument)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(path.resolve(import.meta.dirname, '../../..'))}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>IRIS_RUNTIME_DATA_ROOT</key><string>${xml(dataRoot)}</string>`,
    `    <key>PATH</key><string>${xml([path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter))}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>StandardOutPath</key><string>${xml(paths.stdout)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(paths.stderr)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export async function writeLaunchAgent(dataRoot: string, executable: string, controlScript: string, executableArguments: readonly string[] = []): Promise<LaunchdPaths> {
  const paths = launchdPaths(dataRoot);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.stdout), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(`${paths.plist}.metadata.json`, {
    schemaVersion: 1,
    label: LAUNCH_AGENT_LABEL,
    executable,
    controlScript,
    executableArguments,
    plist: paths.plist,
  });
  const { writePrivateTextAtomic } = await import('./credentials.js');
  await writePrivateTextAtomic(paths.plist, renderLaunchAgent(dataRoot, executable, controlScript, executableArguments));
  return paths;
}

export async function installLaunchAgent(dataRoot: string, executable: string, controlScript: string, executableArguments: readonly string[] = []): Promise<LaunchdPaths> {
  await access(controlScript).catch(() => { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Build IRIS before installing its LaunchAgent'); });
  const paths = await writeLaunchAgent(dataRoot, executable, controlScript, executableArguments);
  const domain = launchdDomain();
  const serviceTarget = `${domain}/${LAUNCH_AGENT_LABEL}`;
  try {
    await execFileAsync('launchctl', ['bootout', serviceTarget], { encoding: 'utf8', timeout: 5_000 }).catch(() => undefined);
    await execFileAsync('launchctl', ['bootstrap', domain, paths.plist], { encoding: 'utf8', timeout: 5_000 });
  } catch (error) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Could not install the IRIS LaunchAgent', { cause: error });
  }
  return paths;
}

export async function uninstallLaunchAgent(dataRoot: string): Promise<void> {
  const paths = launchdPaths(dataRoot);
  await execFileAsync('launchctl', ['bootout', `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`], { encoding: 'utf8', timeout: 5_000 }).catch(() => undefined);
  await rm(paths.plist, { force: true });
  await rm(`${paths.plist}.metadata.json`, { force: true });
}

export async function launchAgentLoaded(): Promise<boolean> {
  try { await execFileAsync('launchctl', ['print', `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`], { encoding: 'utf8', timeout: 2_000 }); return true; }
  catch { return false; }
}

function launchdDomain(): string {
  if (typeof process.getuid !== 'function') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'User LaunchAgents require a macOS user identity');
  return `gui/${process.getuid()}`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
