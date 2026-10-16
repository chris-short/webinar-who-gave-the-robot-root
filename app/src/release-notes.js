/**
 * Formats a release note line for the release bucket.
 * @param {{ version: string, commit: string, approvedBy?: string }} release
 */
export function releaseNote({ version, commit, approvedBy }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  const shortCommit = commit.slice(0, 7);
  const approval = approvedBy ? `approved by ${approvedBy}` : 'awaiting approval';
  return `v${version} (${shortCommit}) ${approval}`;
}
