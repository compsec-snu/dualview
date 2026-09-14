/**
 * Restricted exec mount wrapper construction.
 *
 * RESTRICTED=1 exec runs against trusted worktrees. Linux uses bind mounts in a
 * mount namespace; macOS rewrites tracked paths and denies Human filesystem
 * access with sandbox-exec.
 */

export interface RestrictedExecMount {
  trustedPath: string;
  workTree: string;
  protectedFiles?: string[];
  protectedDirs?: string[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sortedMounts(mounts: RestrictedExecMount[]): RestrictedExecMount[] {
  return [...mounts].sort((a, b) => a.workTree.length - b.workTree.length);
}

function sortedMountsLongestFirst(
  mounts: RestrictedExecMount[],
): RestrictedExecMount[] {
  return [...mounts].sort((a, b) => b.workTree.length - a.workTree.length);
}

function rewriteHumanPathsForMacOs(
  value: string,
  mounts: RestrictedExecMount[],
): string {
  return sortedMountsLongestFirst(mounts).reduce(
    (rewritten, mount) => rewritten.split(mount.workTree).join(mount.trustedPath),
    value,
  );
}

/**
 * Build the shell command used for restricted exec filesystem isolation.
 */
export function buildRestrictedExecCommand(
  originalCommand: string,
  mounts: RestrictedExecMount[],
): string {
  const mountCommands = sortedMounts(mounts).map((mount) =>
    `mount --bind ${shellQuote(mount.trustedPath)} ${shellQuote(mount.workTree)}`,
  );
  const metadataMasks = sortedMounts(mounts).flatMap((mount) => [
    ...(mount.protectedFiles ?? []).map(
      (path) => `mount --bind /dev/null ${shellQuote(path)}`,
    ),
    ...(mount.protectedDirs ?? []).map(
      (path) => `mount -t tmpfs -o mode=000 tmpfs ${shellQuote(path)}`,
    ),
  ]);
  const script = [
    ...metadataMasks,
    ...mountCommands,
    `exec sh -c ${shellQuote(originalCommand)}`,
  ].join(" && ");
  return `unshare -Umr --propagation unchanged sh -c ${shellQuote(script)}`;
}

/**
 * Build the complete Linux AgentShell command. The outer namespace disables
 * networking; the existing restricted-exec wrapper supplies the mount view.
 */
export function buildLinuxAgentShellCommand(
  originalCommand: string,
  mounts: RestrictedExecMount[],
): string {
  const restrictedCommand = buildRestrictedExecCommand(originalCommand, mounts);
  return `unshare -nc -- sh -c ${shellQuote(restrictedCommand)}`;
}

/**
 * Best-effort macOS equivalent. The caller must run this from the trusted
 * worktree because macOS has no Linux-style mount namespace.
 */
export function buildMacOsAgentShellCommand(
  originalCommand: string,
  mounts: RestrictedExecMount[],
): string {
  const deniedHumanViews = mounts.map(
    (mount) =>
      `(deny file-read* file-write* (subpath ${JSON.stringify(mount.workTree)}))`,
  );
  const deniedMetadata = mounts.flatMap((mount) => [
    ...(mount.protectedFiles ?? []),
    ...(mount.protectedDirs ?? []),
  ]).map(
    (path) =>
      `(deny file-read* file-write* (literal ${JSON.stringify(path)})) ` +
      `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`,
  );
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...deniedHumanViews,
    ...deniedMetadata,
  ].join(" ");
  return `sandbox-exec -p ${shellQuote(profile)} sh -c ${shellQuote(originalCommand)}`;
}

export function buildPlatformRestrictedExecCommand(
  originalCommand: string,
  mounts: RestrictedExecMount[],
  platform = process.platform,
): string {
  if (platform === "darwin") {
    return buildMacOsAgentShellCommand(
      rewriteHumanPathsForMacOs(originalCommand, mounts),
      mounts,
    );
  }
  return buildRestrictedExecCommand(originalCommand, mounts);
}

export function rewritePlatformRestrictedExecWorkdir(
  workdir: string | undefined,
  mounts: RestrictedExecMount[],
  platform = process.platform,
): string | undefined {
  if (platform !== "darwin") return workdir;
  if (!workdir) return mounts.length === 1 ? mounts[0]?.trustedPath : undefined;
  return rewriteHumanPathsForMacOs(workdir, mounts);
}

export function buildLinuxConcreteShellCommand(
  originalCommand: string,
  mounts: RestrictedExecMount[],
): string {
  const readOnlyMounts = sortedMounts(mounts).flatMap((mount) => [
    mount.trustedPath,
    ...(mount.protectedFiles ?? []),
    ...(mount.protectedDirs ?? []),
  ]).flatMap((path) => [
    `mount --bind ${shellQuote(path)} ${shellQuote(path)}`,
    `mount -o remount,bind,ro ${shellQuote(path)}`,
  ]);
  const script = [...readOnlyMounts, `exec sh -c ${shellQuote(originalCommand)}`].join(" && ");
  return `unshare -Umr --propagation unchanged sh -c ${shellQuote(script)}`;
}

export function buildMacOsConcreteShellCommand(
  originalCommand: string,
  mounts: RestrictedExecMount[],
): string {
  const deniedWrites = sortedMounts(mounts).flatMap((mount) => [
    mount.trustedPath,
    ...(mount.protectedFiles ?? []),
    ...(mount.protectedDirs ?? []),
  ]).map(
    (path) =>
      `(deny file-write* (literal ${JSON.stringify(path)})) ` +
      `(deny file-write* (subpath ${JSON.stringify(path)}))`,
  );
  const profile = ["(version 1)", "(allow default)", ...deniedWrites].join(" ");
  return `sandbox-exec -p ${shellQuote(profile)} sh -c ${shellQuote(originalCommand)}`;
}
