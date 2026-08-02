/**
 * Restricted exec mount wrapper construction.
 *
 * RESTRICTED=1 exec runs inside a mount namespace where trusted worktrees are
 * bind-mounted over their human-view paths. The command string returned here is
 * passed to OpenClaw's normal exec tool.
 */

export interface RestrictedExecMount {
  trustedPath: string;
  workTree: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sortedMounts(mounts: RestrictedExecMount[]): RestrictedExecMount[] {
  return [...mounts].sort((a, b) => a.workTree.length - b.workTree.length);
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
  const script = [...mountCommands, `exec sh -c ${shellQuote(originalCommand)}`].join(" && ");
  return `unshare -Umr --propagation unchanged sh -c ${shellQuote(script)}`;
}
