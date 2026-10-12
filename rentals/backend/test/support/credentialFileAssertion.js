const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function assertCredentialFileProtected(outputFile) {
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(outputFile)).mode & 0o777, 0o600);
    return;
  }

  const [{ stdout: acl }, { stdout: identity }, { stdout: userDetails }] = await Promise.all([
    execFileAsync("icacls.exe", [outputFile], { windowsHide: true }),
    execFileAsync("whoami.exe", [], { windowsHide: true }),
    execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true })
  ]);
  const sid = userDetails.match(/S-\d+(?:-\d+)+/i)?.[0];
  const normalizedAcl = acl.toLowerCase();
  const normalizedIdentity = identity.trim().toLowerCase();

  assert.doesNotMatch(acl, /\(I\)/i, "credential ACL must not inherit parent access rules");
  assert.ok(
    normalizedAcl.includes(normalizedIdentity) || (sid && normalizedAcl.includes(sid.toLowerCase())),
    "credential ACL must grant the current Windows user access"
  );
  assert.deepEqual(
    acl.match(/\([A-Z,]+\)/gi)?.map((token) => token.toUpperCase()),
    ["(F)"],
    "credential ACL must contain only the current user's full-control rule"
  );
}

module.exports = { assertCredentialFileProtected };
