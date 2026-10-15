import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';
import { RUNTIME_DATA_ENV } from './data-root.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24Path } from './node-runtime.js';
import { inspectRegistrationRoot } from './project-path.js';
import { PROTECTED_REFERENCE_ROOT_ENV } from './permissions.js';

const execFileAsync = promisify(execFile);
export const LAUNCH_AGENT_LABEL = 'com.iris.supervisor' as const;

export interface LaunchdPaths {
  readonly directory: string;
  readonly plist: string;
  readonly metadata: string;
  readonly registrationDirectory: string;
  readonly registeredPlist: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LaunchdStatus {
  readonly domain: string;
  readonly loaded: boolean;
  readonly disabled: boolean;
  readonly registered: boolean;
  readonly paths: LaunchdPaths;
}

export interface LaunchdDependencies {
  readonly homeDirectory?: string;
  readonly uid?: number;
  readonly launchctl?: (argumentsList: readonly string[]) => Promise<{ readonly stdout: string }>;
}

interface LegacyLaunchAgentMetadata {
  readonly schemaVersion: 1;
  readonly label: typeof LAUNCH_AGENT_LABEL;
  readonly executable: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly plist: string;
}

interface LegacyMigrationEvidence {
  readonly fromSchemaVersion: 1;
  readonly metadataSha256: string;
  readonly plistSha256: string;
  readonly executable: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly plist: string;
  readonly observedState: 'ABSENT';
  readonly disabledBeforeMigration: boolean;
}

interface LaunchAgentMetadata {
  readonly schemaVersion: 3;
  readonly label: typeof LAUNCH_AGENT_LABEL;
  readonly domain: string;
  readonly dataRoot: string;
  readonly sourceRoot: string;
  readonly executable: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly plist: string;
  readonly registeredPlist: string;
  readonly plistSha256: string;
  readonly state: 'PREPARED' | 'INSTALLING' | 'READY' | 'UNINSTALLING' | 'RECONCILIATION_REQUIRED';
  readonly disabledBeforeInstall: boolean;
  readonly unresolvedReason: 'BOOTSTRAP_OUTCOME_UNKNOWN' | 'LIVE_IDENTITY_UNVERIFIED' | 'PUBLISHED_STATE_CHANGED' | 'DISABLED_STATE_UNKNOWN' | 'BOOTOUT_OUTCOME_UNKNOWN' | null;
  readonly legacyMigration?: LegacyMigrationEvidence;
}

interface LaunchAgentMetadataRecord {
  readonly metadata: LaunchAgentMetadata | LegacyLaunchAgentMetadata;
  readonly raw: string;
}

type LaunchAgentObservation =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'LOADED'; readonly stdout: string };

interface LiveLaunchAgentIdentity {
  readonly registeredPlist: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly dataRoot: string;
}

export function launchdPaths(dataRoot: string, homeDirectory = os.homedir()): LaunchdPaths {
  const directory = path.join(dataRoot, 'launchd');
  const registrationDirectory = path.join(homeDirectory, 'Library', 'LaunchAgents');
  return {
    directory,
    plist: path.join(directory, `${LAUNCH_AGENT_LABEL}.plist`),
    metadata: path.join(directory, `${LAUNCH_AGENT_LABEL}.plist.metadata.json`),
    registrationDirectory,
    registeredPlist: path.join(registrationDirectory, `${LAUNCH_AGENT_LABEL}.plist`),
    stdout: path.join(dataRoot, 'logs', 'supervisor.log'),
    stderr: path.join(dataRoot, 'logs', 'supervisor-error.log'),
  };
}

export function renderLaunchAgent(
  dataRoot: string,
  executable: string,
  controlScript: string,
  executableArguments: readonly string[] = [],
  protectedReferenceRoot?: string,
): string {
  const paths = launchdPaths(dataRoot);
  const argumentsList = [executable, ...executableArguments, controlScript, 'supervisor'];
  const configuredProtectedReferenceRoot = protectedReferenceRoot?.trim();
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
    `  <key>WorkingDirectory</key><string>${xml(sourceRootForControlScript(controlScript))}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>${RUNTIME_DATA_ENV}</key><string>${xml(dataRoot)}</string>`,
    `    <key>PATH</key><string>${xml(node24Path(executable))}</string>`,
    ...(configuredProtectedReferenceRoot === undefined || configuredProtectedReferenceRoot.length === 0
      ? []
      : [`    <key>${PROTECTED_REFERENCE_ROOT_ENV}</key><string>${xml(configuredProtectedReferenceRoot)}</string>`]),
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

export async function installLaunchAgent(
  dataRoot: string,
  requestedExecutable: string,
  controlScript: string,
  executableArguments: readonly string[] = [],
  protectedReferenceRoot?: string,
  dependencies: LaunchdDependencies = {},
): Promise<LaunchdPaths> {
  assertSupportedNodeVersion();
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const canonicalControlScript = await requireCanonicalFile(controlScript, 'IRIS control script', uid);
  const sourceRoot = await requireCanonicalDirectory(sourceRootForControlScript(canonicalControlScript), 'IRIS source root', uid, false);
  const executable = await realpath(canonicalNodeRuntime().path);
  await access(canonicalControlScript).catch(() => { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Build IRIS before installing its LaunchAgent'); });

  let canonicalProtectedReferenceRoot: string | undefined;
  if (protectedReferenceRoot !== undefined && protectedReferenceRoot.trim().length > 0) {
    const inspection = await inspectRegistrationRoot(protectedReferenceRoot.trim());
    if (!inspection.valid || inspection.target === null) {
      throw new RuntimeError('INVALID_PROJECT_PATH', `${PROTECTED_REFERENCE_ROOT_ENV} must identify an existing canonical non-root directory`);
    }
    canonicalProtectedReferenceRoot = inspection.target;
  }

  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const serviceTarget = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);

  const plist = renderLaunchAgent(canonicalDataRoot, executable, canonicalControlScript, executableArguments, canonicalProtectedReferenceRoot);
  const existingRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  const observationBefore = await observeLaunchAgent(dependencies);
  const desiredBinding: Omit<LaunchAgentMetadata, 'state' | 'disabledBeforeInstall' | 'unresolvedReason'> = {
    schemaVersion: 3,
    label: LAUNCH_AGENT_LABEL,
    domain,
    dataRoot: canonicalDataRoot,
    sourceRoot,
    executable,
    controlScript: canonicalControlScript,
    executableArguments: [...executableArguments],
    plist: paths.plist,
    registeredPlist: paths.registeredPlist,
    plistSha256: sha256(plist),
  };
  const existingMetadata = existingRecord?.metadata.schemaVersion === 1
    ? await migrateLegacyLaunchAgent({
      record: { metadata: existingRecord.metadata, raw: existingRecord.raw },
      observation: observationBefore,
      desiredBinding,
      desiredPlist: plist,
      requestedExecutable,
      ...(canonicalProtectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: canonicalProtectedReferenceRoot }),
      paths,
      domain,
      launchctl,
      uid,
    })
    : existingRecord?.metadata ?? null;

  if (existingMetadata?.legacyMigration !== undefined) {
    await completeLegacyPlistTransition(paths.plist, plist, existingMetadata.legacyMigration.plistSha256, uid);
  }

  if (observationBefore.state === 'LOADED') {
    if (existingMetadata === null) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A loaded LaunchAgent has no durable ownership metadata');
    }
    requireMetadataBinding(existingMetadata, desiredBinding);
    await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
    await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
    requireLiveLaunchAgentIdentity(observationBefore.stdout, existingMetadata);
    try {
      await reconcileDisabledState(false, domain, serviceTarget, launchctl);
      await writeLaunchAgentMetadata(paths.metadata, { ...existingMetadata, state: 'READY', unresolvedReason: null }, uid);
    } catch (error) {
      await recordUnresolved(paths.metadata, existingMetadata, 'DISABLED_STATE_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded LaunchAgent persistence could not be verified', { cause: error });
    }
    return paths;
  }

  if (existingMetadata?.state === 'UNINSTALLING') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'An interrupted LaunchAgent uninstall requires reconciliation');
  }
  if (existingMetadata !== null) requireMetadataBinding(existingMetadata, desiredBinding);

  await ensureOwnedDirectory(paths.directory, 'IRIS launchd directory', uid, true);
  await ensureOwnedDirectory(path.dirname(paths.stdout), 'IRIS log directory', uid, true);
  await ensureOwnedDirectory(paths.registrationDirectory, 'User LaunchAgents directory', uid, false);
  await requireCompatibleContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
  await requireCompatibleContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);

  const disabledBeforeInstall = existingMetadata?.disabledBeforeInstall ?? await launchAgentDisabled(domain, launchctl);
  const preparedMetadata: LaunchAgentMetadata = {
    ...desiredBinding,
    state: 'PREPARED',
    disabledBeforeInstall,
    unresolvedReason: null,
    ...(existingMetadata?.legacyMigration === undefined ? {} : { legacyMigration: existingMetadata.legacyMigration }),
  };
  await publishOwnedFile(paths.plist, plist, 'IRIS private LaunchAgent', uid);
  if (existingMetadata === null) await publishOwnedFile(paths.metadata, metadataContent(preparedMetadata), 'IRIS LaunchAgent metadata', uid);
  else await writeLaunchAgentMetadata(paths.metadata, preparedMetadata, uid);
  await publishOwnedFile(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
  await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
  await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
  const installingMetadata = { ...preparedMetadata, state: 'INSTALLING' as const };
  await writeLaunchAgentMetadata(paths.metadata, installingMetadata, uid);

  try {
    await reconcileDisabledState(false, domain, serviceTarget, launchctl);
  } catch (error) {
    await rollbackFailedInstall(paths, installingMetadata, plist, 'DISABLED_STATE_UNKNOWN', uid, dependencies, error);
  }

  let bootstrapError: unknown;
  try { await launchctl(['bootstrap', domain, paths.registeredPlist]); } catch (error) { bootstrapError = error; }
  let observationAfter: LaunchAgentObservation;
  try { observationAfter = await observeLaunchAgent(dependencies); }
  catch (error) {
    await recordUnresolved(paths.metadata, installingMetadata, 'BOOTSTRAP_OUTCOME_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent bootstrap outcome requires reconciliation', { cause: error });
  }
  if (observationAfter.state === 'ABSENT') {
    return rollbackFailedInstall(paths, installingMetadata, plist, 'BOOTSTRAP_OUTCOME_UNKNOWN', uid, dependencies, bootstrapError);
  }
  try { requireLiveLaunchAgentIdentity(observationAfter.stdout, installingMetadata); }
  catch (error) {
    await recordUnresolved(paths.metadata, installingMetadata, 'LIVE_IDENTITY_UNVERIFIED', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded LaunchAgent identity is not the requested installation', { cause: error });
  }
  try {
    await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
    await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
    if (await launchAgentDisabled(domain, launchctl)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The installed LaunchAgent is disabled');
    await writeLaunchAgentMetadata(paths.metadata, { ...installingMetadata, state: 'READY', unresolvedReason: null }, uid);
  } catch (error) {
    await rollbackFailedInstall(paths, installingMetadata, plist, 'PUBLISHED_STATE_CHANGED', uid, dependencies, error);
  }
  return paths;
}

export async function uninstallLaunchAgent(dataRoot: string, dependencies: LaunchdDependencies = {}): Promise<void> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  if (metadataRecord?.metadata.schemaVersion === 1) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent metadata requires an authorized install migration before uninstall');
  }
  const metadata = metadataRecord?.metadata ?? null;
  const observation = await observeLaunchAgent(dependencies);
  if (metadata === null) {
    const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
    if (observation.state === 'LOADED' || registered.state !== 'missing' || privatePlist.state !== 'missing') {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent ownership metadata is unavailable; refusing unverified removal');
    }
    return;
  }
  if (metadata.dataRoot !== canonicalDataRoot || metadata.domain !== domain || metadata.plist !== paths.plist || metadata.registeredPlist !== paths.registeredPlist) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent ownership metadata conflicts with the requested installation');
  }
  const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  for (const inspected of [registered, privatePlist]) {
    if (inspected.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspected.reason);
    if (inspected.state === 'ok' && sha256(inspected.content) !== metadata.plistSha256) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent content no longer matches its durable ownership metadata');
    }
  }
  if (observation.state === 'LOADED') requireLiveLaunchAgentIdentity(observation.stdout, metadata);
  await writeLaunchAgentMetadata(paths.metadata, { ...metadata, state: 'UNINSTALLING', unresolvedReason: null }, uid);
  if (observation.state === 'LOADED') {
    let bootoutError: unknown;
    try { await launchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]); } catch (error) { bootoutError = error; }
    let afterBootout: LaunchAgentObservation;
    try { afterBootout = await observeLaunchAgent(dependencies); }
    catch (error) {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent unload outcome requires reconciliation', { cause: error });
    }
    if (afterBootout.state === 'LOADED') {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Could not safely unload the IRIS LaunchAgent', { cause: bootoutError });
    }
  }
  try { await reconcileDisabledState(metadata.disabledBeforeInstall, domain, `${domain}/${LAUNCH_AGENT_LABEL}`, launchctl); }
  catch (error) {
    await recordUnresolved(paths.metadata, metadata, 'DISABLED_STATE_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent disabled-state restoration requires reconciliation', { cause: error });
  }
  await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  await removeOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  await removeOwnedFile(paths.metadata, 'IRIS LaunchAgent metadata', uid);
}

export async function launchAgentStatus(dataRoot: string, dependencies: LaunchdDependencies = {}): Promise<LaunchdStatus> {
  const paths = launchdPaths(dataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, launchdUid(dependencies));
  if (metadataRecord?.metadata.schemaVersion === 1) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent metadata requires an authorized install migration');
  }
  const metadata = metadataRecord?.metadata ?? null;
  const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', launchdUid(dependencies));
  if (registered.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', registered.reason);
  if (registered.state === 'ok' && (metadata === null || metadata.registeredPlist !== paths.registeredPlist || sha256(registered.content) !== metadata.plistSha256)) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Registered LaunchAgent does not match durable ownership metadata');
  }
  const observation = await observeLaunchAgent(dependencies);
  if (observation.state === 'LOADED') {
    if (metadata === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded LaunchAgent has no durable ownership metadata');
    requireLiveLaunchAgentIdentity(observation.stdout, metadata);
  }
  return { domain, loaded: observation.state === 'LOADED', disabled: await launchAgentDisabled(domain, launchctl), registered: registered.state === 'ok', paths };
}

export async function launchAgentLoaded(dependencies: LaunchdDependencies = {}): Promise<boolean> {
  return (await observeLaunchAgent(dependencies)).state === 'LOADED';
}

async function observeLaunchAgent(dependencies: LaunchdDependencies): Promise<LaunchAgentObservation> {
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  const attempts = dependencies.launchctl === undefined ? 50 : 1;
  let lastUnknown: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { stdout } = await launchctl(['print', `${launchdDomain(dependencies)}/${LAUNCH_AGENT_LABEL}`]);
      return { state: 'LOADED', stdout };
    } catch (error) {
      if (launchAgentAbsent(error, launchdDomain(dependencies))) return { state: 'ABSENT' };
      lastUnknown = error;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent state remained unknown after reconciliation', { cause: lastUnknown });
}

async function rollbackFailedInstall(
  paths: LaunchdPaths,
  metadata: LaunchAgentMetadata,
  plist: string,
  reason: NonNullable<LaunchAgentMetadata['unresolvedReason']>,
  uid: number,
  dependencies: LaunchdDependencies,
  cause: unknown,
): Promise<never> {
  const domain = metadata.domain;
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  let observation: LaunchAgentObservation;
  try { observation = await observeLaunchAgent(dependencies); }
  catch (error) {
    await recordUnresolved(paths.metadata, metadata, reason, uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent install outcome requires reconciliation', { cause: error });
  }
  if (observation.state === 'LOADED') {
    try { requireLiveLaunchAgentIdentity(observation.stdout, metadata); }
    catch (error) {
      await recordUnresolved(paths.metadata, metadata, 'LIVE_IDENTITY_UNVERIFIED', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Refusing to unload a LaunchAgent whose live identity is unverified', { cause: error });
    }
    let bootoutError: unknown;
    try { await launchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]); } catch (error) { bootoutError = error; }
    let afterBootout: LaunchAgentObservation;
    try { afterBootout = await observeLaunchAgent(dependencies); }
    catch (error) {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent rollback outcome requires reconciliation', { cause: error });
    }
    if (afterBootout.state === 'LOADED') {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent rollback could not verify process exit', { cause: bootoutError });
    }
  }
  try { await reconcileDisabledState(metadata.disabledBeforeInstall, domain, `${domain}/${LAUNCH_AGENT_LABEL}`, launchctl); }
  catch (error) {
    await recordUnresolved(paths.metadata, metadata, 'DISABLED_STATE_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent disabled-state rollback requires reconciliation', { cause: error });
  }
  const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (registered.state === 'invalid' || registered.state === 'ok' && registered.content !== plist) {
    await recordUnresolved(paths.metadata, metadata, 'PUBLISHED_STATE_CHANGED', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent registration changed during rollback');
  }
  if (registered.state === 'ok') await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  await writeLaunchAgentMetadata(paths.metadata, { ...metadata, state: 'PREPARED', unresolvedReason: null }, uid);
  throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Could not install the IRIS LaunchAgent', { cause });
}

interface LegacyMigrationInput {
  readonly record: LaunchAgentMetadataRecord & { readonly metadata: LegacyLaunchAgentMetadata };
  readonly observation: LaunchAgentObservation;
  readonly desiredBinding: Omit<LaunchAgentMetadata, 'state' | 'disabledBeforeInstall' | 'unresolvedReason'>;
  readonly desiredPlist: string;
  readonly requestedExecutable: string;
  readonly protectedReferenceRoot?: string;
  readonly paths: LaunchdPaths;
  readonly domain: string;
  readonly launchctl: NonNullable<LaunchdDependencies['launchctl']>;
  readonly uid: number;
}

async function migrateLegacyLaunchAgent(input: LegacyMigrationInput): Promise<LaunchAgentMetadata> {
  const legacy = input.record.metadata;
  if (input.observation.state !== 'ABSENT') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A loaded legacy LaunchAgent must be stopped before authorized metadata migration');
  }
  const requestedExecutable = path.resolve(input.requestedExecutable);
  const legacyExecutable = await realpath(legacy.executable).catch((error) => {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent executable cannot be verified', { cause: error });
  });
  if (legacy.label !== LAUNCH_AGENT_LABEL
    || legacy.executable !== requestedExecutable
    || legacyExecutable !== input.desiredBinding.executable
    || legacy.controlScript !== input.desiredBinding.controlScript
    || legacy.plist !== input.paths.plist
    || legacy.executableArguments.length !== input.desiredBinding.executableArguments.length
    || legacy.executableArguments.some((argument, index) => argument !== input.desiredBinding.executableArguments[index])) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent ownership metadata conflicts with the requested installation');
  }
  const legacyPlist = renderLaunchAgent(
    input.desiredBinding.dataRoot,
    legacy.executable,
    legacy.controlScript,
    legacy.executableArguments,
    input.protectedReferenceRoot,
  );
  await requirePublishedContent(input.paths.plist, legacyPlist, 'legacy IRIS LaunchAgent', input.uid);
  const registered = await inspectOwnedFile(input.paths.registeredPlist, 'IRIS registered LaunchAgent', input.uid);
  if (registered.state !== 'missing') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent registration conflicts with the schema migration');
  }
  const disabledBeforeMigration = await launchAgentDisabled(input.domain, input.launchctl);
  const migrated: LaunchAgentMetadata = {
    ...input.desiredBinding,
    state: 'PREPARED',
    disabledBeforeInstall: disabledBeforeMigration,
    unresolvedReason: null,
    legacyMigration: {
      fromSchemaVersion: 1,
      metadataSha256: sha256(input.record.raw),
      plistSha256: sha256(legacyPlist),
      executable: legacy.executable,
      controlScript: legacy.controlScript,
      executableArguments: [...legacy.executableArguments],
      plist: legacy.plist,
      observedState: 'ABSENT',
      disabledBeforeMigration,
    },
  };
  await replaceOwnedFile(input.paths.metadata, input.record.raw, metadataContent(migrated), 'IRIS LaunchAgent metadata', input.uid);
  await completeLegacyPlistTransition(input.paths.plist, input.desiredPlist, migrated.legacyMigration!.plistSha256, input.uid);
  return migrated;
}

async function completeLegacyPlistTransition(filename: string, desired: string, legacySha256: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, 'IRIS private LaunchAgent', uid);
  if (inspected.state !== 'ok') {
    throw new RuntimeError('PERSISTENCE_FAILURE', inspected.state === 'invalid' ? inspected.reason : 'IRIS private LaunchAgent is missing during legacy migration');
  }
  if (inspected.content === desired) return;
  if (sha256(inspected.content) !== legacySha256) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Legacy LaunchAgent changed during metadata migration');
  }
  await replaceOwnedFile(filename, inspected.content, desired, 'IRIS private LaunchAgent', uid);
}

function requireLiveLaunchAgentIdentity(stdout: string, metadata: LaunchAgentMetadata): void {
  if (!stdout.split(/\r?\n/).some((line) => line.trim() === `${metadata.domain}/${metadata.label} = {`)) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Live LaunchAgent label is not the recorded service');
  }
  const live = parseLiveLaunchAgentIdentity(stdout);
  const expectedArguments = [metadata.executable, ...metadata.executableArguments, metadata.controlScript, 'supervisor'];
  if (live.registeredPlist !== metadata.registeredPlist
    || live.executable !== metadata.executable
    || live.workingDirectory !== metadata.sourceRoot
    || live.dataRoot !== metadata.dataRoot
    || live.arguments.length !== expectedArguments.length
    || live.arguments.some((argument, index) => argument !== expectedArguments[index])) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Live LaunchAgent identity conflicts with durable ownership metadata');
  }
}

function parseLiveLaunchAgentIdentity(stdout: string): LiveLaunchAgentIdentity {
  const lines = stdout.split(/\r?\n/);
  const registeredPlist = launchctlScalar(lines, 'path');
  const executable = launchctlScalar(lines, 'program');
  const workingDirectory = launchctlScalar(lines, 'working directory');
  const dataRoot = launchctlMapping(lines, 'environment', RUNTIME_DATA_ENV);
  const argumentsList = launchctlList(lines, 'arguments');
  if (registeredPlist === null || executable === null || workingDirectory === null || dataRoot === null || argumentsList === null) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Live LaunchAgent identity output is incomplete');
  }
  return { registeredPlist, executable, arguments: argumentsList, workingDirectory, dataRoot };
}

function launchctlScalar(lines: readonly string[], key: string): string | null {
  const prefix = `${key} = `;
  const matches = lines.map((line) => line.trim()).filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) return null;
  return decodeLaunchctlValue(matches[0]!.slice(prefix.length));
}

function launchctlList(lines: readonly string[], key: string): readonly string[] | null {
  const block = launchctlBlock(lines, `${key} = {`);
  if (block === null || block.length === 0) return null;
  const values = block.map(decodeLaunchctlValue);
  return values.every((value): value is string => value !== null) ? values : null;
}

function launchctlMapping(lines: readonly string[], blockName: string, key: string): string | null {
  const block = launchctlBlock(lines, `${blockName} = {`);
  if (block === null) return null;
  const prefix = `${key} => `;
  const matches = block.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) return null;
  return decodeLaunchctlValue(matches[0]!.slice(prefix.length));
}

function launchctlBlock(lines: readonly string[], header: string): readonly string[] | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value === '}') return values;
    if (value.length === 0 || value.includes('\0')) return null;
    values.push(value);
  }
  return null;
}

function decodeLaunchctlValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) return null;
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const decoded = JSON.parse(trimmed) as unknown;
    return typeof decoded === 'string' && !decoded.includes('\0') ? decoded : null;
  } catch { return null; }
}

async function reconcileDisabledState(
  expectedDisabled: boolean,
  domain: string,
  serviceTarget: string,
  launchctl: NonNullable<LaunchdDependencies['launchctl']>,
): Promise<void> {
  if (await launchAgentDisabled(domain, launchctl) === expectedDisabled) return;
  let commandError: unknown;
  try { await launchctl([expectedDisabled ? 'disable' : 'enable', serviceTarget]); } catch (error) { commandError = error; }
  if (await launchAgentDisabled(domain, launchctl) !== expectedDisabled) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Could not ${expectedDisabled ? 'disable' : 'enable'} the IRIS LaunchAgent`, { cause: commandError });
  }
}

async function recordUnresolved(
  filename: string,
  metadata: LaunchAgentMetadata,
  unresolvedReason: NonNullable<LaunchAgentMetadata['unresolvedReason']>,
  uid: number,
): Promise<void> {
  await writeLaunchAgentMetadata(filename, { ...metadata, state: 'RECONCILIATION_REQUIRED', unresolvedReason }, uid);
}

function launchAgentAbsent(error: unknown, domain: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown; readonly message?: unknown; readonly killed?: unknown; readonly signal?: unknown };
  if (failure.code !== 113 || failure.stdout !== '' || failure.killed === true || failure.signal !== undefined && failure.signal !== null) return false;
  const expected = `Could not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${domain.slice('gui/'.length)}`;
  if (typeof failure.stderr !== 'string' || ![expected, `Bad request.\n${expected}`].includes(failure.stderr.trim())) return false;
  const diagnostics = [failure.stderr, failure.message].filter((value): value is string => typeof value === 'string').join('\n');
  return !/permission denied|operation not permitted|not authorized|authorization/i.test(diagnostics);
}

async function requireGuiDomain(domain: string, launchctl: NonNullable<LaunchdDependencies['launchctl']>): Promise<void> {
  try { await launchctl(['print', domain]); }
  catch (error) { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The ${domain} launchd domain is unavailable`, { cause: error }); }
}

async function launchAgentDisabled(domain: string, launchctl: NonNullable<LaunchdDependencies['launchctl']>): Promise<boolean> {
  let stdout: string;
  try { ({ stdout } = await launchctl(['print-disabled', domain])); }
  catch (error) { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Could not inspect disabled services in ${domain}`, { cause: error }); }
  const disabled = parseLaunchAgentDisabled(stdout);
  if (disabled === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The disabled state of ${LAUNCH_AGENT_LABEL} in ${domain} is unknown`);
  return disabled;
}

function parseLaunchAgentDisabled(stdout: string): boolean | null {
  if (stdout.length > 1_048_576 || stdout.includes('\0')) return null;
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines[0] !== 'disabled services = {' || lines.at(-1) !== '}' || lines.length < 3) return null;
  const matches: boolean[] = [];
  for (const line of lines.slice(1, -1)) {
    const entry = /^("(?:[^"\\]|\\.)+")\s*=>\s*(enabled|disabled|true|false)$/.exec(line);
    if (entry === null) return null;
    let label: unknown;
    try { label = JSON.parse(entry[1]!); } catch { return null; }
    if (label === LAUNCH_AGENT_LABEL) matches.push(entry[2] === 'disabled' || entry[2] === 'true');
  }
  return matches.length === 1 ? matches[0]! : null;
}

async function systemLaunchctl(argumentsList: readonly string[]): Promise<{ readonly stdout: string }> {
  try {
    const result = await execFileAsync('/bin/launchctl', [...argumentsList], { encoding: 'utf8', timeout: 5_000 });
    return { stdout: String(result.stdout) };
  } catch (error) {
    if (launchctlOutcomeUnknown(error)) throw new LaunchctlOutcomeUnknown('launchctl outcome is unknown', { cause: error });
    throw error;
  }
}

async function ensureOwnedDirectory(directory: string, label: string, uid: number, privateDirectory: boolean): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} metadata is unavailable`, { cause: error }); });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not a physical directory`);
  if (metadata.uid !== uid) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not owned by the current user`);
  if ((metadata.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} permissions permit unsafe access`);
  if (await realpath(directory) !== path.resolve(directory)) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed through a filesystem alias`);
}

async function requireCanonicalDirectory(directory: string, label: string, uid: number, privateDirectory: boolean): Promise<string> {
  const absolute = path.resolve(directory);
  const physical = await realpath(absolute).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cannot be resolved`, { cause: error }); });
  if (physical !== absolute) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed through a filesystem alias`);
  const metadata = await lstat(physical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} ownership or permissions are unsafe`);
  }
  return physical;
}

async function requireCanonicalFile(filename: string, label: string, uid: number): Promise<string> {
  const absolute = path.resolve(filename);
  const physical = await realpath(absolute).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cannot be resolved`, { cause: error }); });
  const metadata = await lstat(physical);
  if (physical !== absolute || !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not a canonical owner-controlled physical file`);
  }
  return physical;
}

type OwnedFileInspection = { readonly state: 'missing' } | { readonly state: 'invalid'; readonly reason: string } | { readonly state: 'ok'; readonly content: string };

async function inspectOwnedFile(filename: string, label: string, uid: number): Promise<OwnedFileInspection> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { return isNotFound(error) ? { state: 'missing' } : { state: 'invalid', reason: `${label} is not a physical file` }; }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) return { state: 'invalid', reason: `${label} ownership or permissions are unsafe` };
    return { state: 'ok', content: await handle.readFile('utf8') };
  } catch { return { state: 'invalid', reason: `${label} is unreadable` }; }
  finally { await handle.close().catch(() => undefined); }
}

async function publishOwnedFile(filename: string, content: string, label: string, uid: number): Promise<void> {
  const existing = await inspectOwnedFile(filename, label, uid);
  if (existing.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', existing.reason);
  if (existing.state === 'ok') {
    if (existing.content === content) return;
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} conflicts with the requested installation`);
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } catch (error) {
    if (!isAlreadyExists(error)) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} publication failed`, { cause: error });
    const concurrent = await inspectOwnedFile(filename, label, uid);
    if (concurrent.state !== 'ok' || concurrent.content !== content) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} publication conflicted with another writer`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function requireCompatibleContent(filename: string, content: string, label: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state === 'missing') return;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  if (inspected.content !== content) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} conflicts with the requested installation`);
}

async function writeLaunchAgentMetadata(filename: string, metadata: LaunchAgentMetadata, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, 'IRIS LaunchAgent metadata', uid);
  if (inspected.state !== 'ok') {
    throw new RuntimeError('PERSISTENCE_FAILURE', inspected.state === 'invalid' ? inspected.reason : 'IRIS LaunchAgent metadata is missing');
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(metadataContent(metadata), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } catch (error) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS LaunchAgent metadata update failed', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceOwnedFile(filename: string, expected: string, content: string, label: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state !== 'ok' || inspected.content !== expected) {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed before its authorized replacement`);
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const beforeRename = await inspectOwnedFile(filename, label, uid);
    if (beforeRename.state !== 'ok' || beforeRename.content !== expected) {
      throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed during its authorized replacement`);
    }
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} replacement failed`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function metadataContent(metadata: LaunchAgentMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function requireMetadataBinding(actual: LaunchAgentMetadata, expected: Omit<LaunchAgentMetadata, 'state' | 'disabledBeforeInstall' | 'unresolvedReason'>): void {
  if (actual.schemaVersion !== expected.schemaVersion
    || actual.label !== expected.label
    || actual.domain !== expected.domain
    || actual.dataRoot !== expected.dataRoot
    || actual.sourceRoot !== expected.sourceRoot
    || actual.executable !== expected.executable
    || actual.controlScript !== expected.controlScript
    || actual.plist !== expected.plist
    || actual.registeredPlist !== expected.registeredPlist
    || actual.plistSha256 !== expected.plistSha256
    || actual.executableArguments.length !== expected.executableArguments.length
    || actual.executableArguments.some((argument, index) => argument !== expected.executableArguments[index])) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent ownership metadata conflicts with the requested installation');
  }
}

async function requirePublishedContent(filename: string, content: string, label: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state !== 'ok' || inspected.content !== content) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed after publication`);
}

async function removeOwnedFile(filename: string, label: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state === 'missing') return;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  await rm(filename);
  await syncDirectory(path.dirname(filename));
}

async function readLaunchAgentMetadata(filename: string, uid: number): Promise<LaunchAgentMetadataRecord | null> {
  const inspected = await inspectOwnedFile(filename, 'IRIS LaunchAgent metadata', uid);
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspected.reason);
  try {
    const value = JSON.parse(inspected.content) as unknown;
    if (!validLaunchAgentMetadata(value) && !validLegacyLaunchAgentMetadata(value)) throw new Error('invalid metadata');
    return { metadata: value, raw: inspected.content };
  } catch (error) { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'IRIS LaunchAgent metadata is invalid', { cause: error }); }
}

function validLegacyLaunchAgentMetadata(value: unknown): value is LegacyLaunchAgentMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as LegacyLaunchAgentMetadata;
  return Object.keys(value).sort().join(',') === 'controlScript,executable,executableArguments,label,plist,schemaVersion'
    && metadata.schemaVersion === 1
    && metadata.label === LAUNCH_AGENT_LABEL
    && [metadata.executable, metadata.controlScript, metadata.plist].every((item) => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0'))
    && Array.isArray(metadata.executableArguments)
    && metadata.executableArguments.every((item) => typeof item === 'string' && !item.includes('\0'));
}

function validLaunchAgentMetadata(value: unknown): value is LaunchAgentMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as LaunchAgentMetadata;
  return metadata.schemaVersion === 3 && metadata.label === LAUNCH_AGENT_LABEL
    && typeof metadata.domain === 'string' && /^gui\/\d+$/.test(metadata.domain)
    && [metadata.dataRoot, metadata.sourceRoot, metadata.executable, metadata.controlScript, metadata.plist, metadata.registeredPlist].every((item) => typeof item === 'string' && path.isAbsolute(item))
    && Array.isArray(metadata.executableArguments) && metadata.executableArguments.every((item) => typeof item === 'string' && !item.includes('\0'))
    && typeof metadata.plistSha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.plistSha256)
    && ['PREPARED', 'INSTALLING', 'READY', 'UNINSTALLING', 'RECONCILIATION_REQUIRED'].includes(metadata.state)
    && typeof metadata.disabledBeforeInstall === 'boolean'
    && (metadata.unresolvedReason === null || ['BOOTSTRAP_OUTCOME_UNKNOWN', 'LIVE_IDENTITY_UNVERIFIED', 'PUBLISHED_STATE_CHANGED', 'DISABLED_STATE_UNKNOWN', 'BOOTOUT_OUTCOME_UNKNOWN'].includes(metadata.unresolvedReason))
    && (metadata.legacyMigration === undefined || validLegacyMigrationEvidence(metadata.legacyMigration));
}

function validLegacyMigrationEvidence(value: unknown): value is LegacyMigrationEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const migration = value as LegacyMigrationEvidence;
  return migration.fromSchemaVersion === 1
    && /^[a-f0-9]{64}$/.test(migration.metadataSha256)
    && /^[a-f0-9]{64}$/.test(migration.plistSha256)
    && [migration.executable, migration.controlScript, migration.plist].every((item) => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0'))
    && Array.isArray(migration.executableArguments)
    && migration.executableArguments.every((item) => typeof item === 'string' && !item.includes('\0'))
    && migration.observedState === 'ABSENT'
    && typeof migration.disabledBeforeMigration === 'boolean';
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function sourceRootForControlScript(controlScript: string): string {
  return path.resolve(path.dirname(controlScript), '../../..');
}

function launchdDomain(dependencies: LaunchdDependencies): string {
  return `gui/${launchdUid(dependencies)}`;
}

function launchdUid(dependencies: LaunchdDependencies): number {
  const uid = dependencies.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'User LaunchAgents require a macOS user identity');
  return uid;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

class LaunchctlOutcomeUnknown extends Error {}

function launchctlOutcomeUnknown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as NodeJS.ErrnoException & { readonly killed?: boolean; readonly signal?: string | null };
  return failure.killed === true || failure.signal !== undefined && failure.signal !== null || failure.code === 'ETIMEDOUT';
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
