const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

class CredentialFileSecurityError extends Error {}

async function ensureProtectedOutputDirectory(outputFile, { fsImpl = fs, platform = process.platform } = {}) {
  const path = require("node:path");
  const directory = path.dirname(outputFile);
  let details;
  try {
    details = await (fsImpl.lstat ? fsImpl.lstat(directory) : fsImpl.stat(directory));
  } catch (_error) {
    throw new CredentialFileSecurityError("The credential output directory does not exist.");
  }

  if (!details.isDirectory() || details.isSymbolicLink?.()) {
    throw new CredentialFileSecurityError("The credential output parent is not a directory.");
  }

  // Windows does not expose DACLs through stat.mode; Node reports synthetic
  // POSIX bits (commonly 0666) for Windows directories. The credential itself
  // is protected with a non-inherited, current-user-only DACL below.
  if (platform !== "win32" && (details.mode & 0o007) !== 0) {
    throw new CredentialFileSecurityError("The credential output directory must not be world-accessible.");
  }
}

function parseWindowsUserSid(stdout) {
  const match = String(stdout || "").match(/S-\d+(?:-\d+)+/i);
  if (!match) throw new CredentialFileSecurityError("The credential output file could not be secured.");
  return match[0];
}

function verifyWindowsCredentialAcl(acl, identityOutput, sid) {
  const identity = String(identityOutput || "").match(/^"([^"]+)"/)?.[1];
  const normalizedAcl = String(acl || "").toLowerCase();
  const permissionTokens = String(acl || "").match(/\([A-Z,]+\)/gi)?.map((token) => token.toUpperCase());
  const belongsToCurrentUser = normalizedAcl.includes(sid.toLowerCase())
    || (identity && normalizedAcl.includes(identity.toLowerCase()));
  if (/\(I\)/i.test(acl) || !belongsToCurrentUser || permissionTokens?.length !== 1 || permissionTokens[0] !== "(F)") {
    throw new CredentialFileSecurityError("The credential output file could not be secured.");
  }
}

async function secureCredentialFile(
  outputFile,
  { fsImpl = fs, platform = process.platform, execFileImpl = execFileAsync } = {}
) {
  if (platform === "win32") {
    try {
      const { stdout } = await execFileImpl(
        "whoami.exe",
        ["/user", "/fo", "csv", "/nh"],
        { windowsHide: true }
      );
      const sid = parseWindowsUserSid(stdout);
      await execFileImpl(
        "icacls.exe",
        [outputFile, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
        { windowsHide: true }
      );

      const { stdout: acl } = await execFileImpl("icacls.exe", [outputFile], { windowsHide: true });
      verifyWindowsCredentialAcl(acl, stdout, sid);
      return;
    } catch (error) {
      if (error instanceof CredentialFileSecurityError) throw error;
      throw new CredentialFileSecurityError("The credential output file could not be secured.");
    }
  }

  try {
    await fsImpl.chmod(outputFile, 0o600);
    const details = await fsImpl.stat(outputFile);
    if ((details.mode & 0o077) !== 0) {
      throw new CredentialFileSecurityError("The credential output file could not be secured.");
    }
  } catch (error) {
    if (error instanceof CredentialFileSecurityError) throw error;
    throw new CredentialFileSecurityError("The credential output file could not be secured.");
  }
}

module.exports = {
  CredentialFileSecurityError,
  ensureProtectedOutputDirectory,
  parseWindowsUserSid,
  secureCredentialFile,
  verifyWindowsCredentialAcl
};
