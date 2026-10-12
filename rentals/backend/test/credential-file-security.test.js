const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureProtectedOutputDirectory,
  secureCredentialFile,
  verifyWindowsCredentialAcl
} = require("../utils/credentialFileSecurity");

function directoryDetails(mode) {
  return {
    mode,
    isDirectory: () => true,
    isSymbolicLink: () => false
  };
}

test("POSIX credential directories retain the non-world-accessible requirement", async () => {
  await ensureProtectedOutputDirectory("/private/credentials/admin.txt", {
    platform: "linux",
    fsImpl: { lstat: async () => directoryDetails(0o700) }
  });

  await assert.rejects(
    ensureProtectedOutputDirectory("/public/credentials/admin.txt", {
      platform: "linux",
      fsImpl: { lstat: async () => directoryDetails(0o707) }
    }),
    /must not be world-accessible/
  );
});

test("Windows uses the current-user SID and removes inherited credential ACLs", async () => {
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({ command, args });
    if (command === "whoami.exe") return { stdout: '"WORKSTATION\\operator","S-1-5-21-1-2-3-1001"\r\n' };
    if (args.length === 1) return { stdout: "C:\\credentials\\admin.txt WORKSTATION\\operator:(F)\r\n" };
    return { stdout: "Successfully processed 1 files\r\n" };
  };

  await ensureProtectedOutputDirectory("C:\\credentials\\admin.txt", {
    platform: "win32",
    fsImpl: { lstat: async () => directoryDetails(0o666) }
  });
  await secureCredentialFile("C:\\credentials\\admin.txt", {
    platform: "win32",
    execFileImpl
  });

  assert.deepEqual(calls[1], {
    command: "icacls.exe",
    args: [
      "C:\\credentials\\admin.txt",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-1-2-3-1001:(F)"
    ]
  });
});

test("POSIX credential protection sets and verifies mode 0600", async () => {
  const calls = [];
  await secureCredentialFile("/private/credentials/admin.txt", {
    platform: "linux",
    fsImpl: {
      async chmod(file, mode) { calls.push({ file, mode }); },
      async stat() { return { mode: 0o600 }; }
    }
  });
  assert.deepEqual(calls, [{ file: "/private/credentials/admin.txt", mode: 0o600 }]);
});

test("Windows ACL verification rejects inherited or additional principals", () => {
  const identity = '"WORKSTATION\\operator","S-1-5-21-1-2-3-1001"';
  assert.throws(
    () => verifyWindowsCredentialAcl(
      "C:\\credentials\\admin.txt WORKSTATION\\operator:(I)(F)",
      identity,
      "S-1-5-21-1-2-3-1001"
    ),
    /could not be secured/
  );
  assert.throws(
    () => verifyWindowsCredentialAcl(
      "C:\\credentials\\admin.txt WORKSTATION\\operator:(F)\r\n Everyone:(R)",
      identity,
      "S-1-5-21-1-2-3-1001"
    ),
    /could not be secured/
  );
});
