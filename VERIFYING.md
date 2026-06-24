# Verifying your OpenDescent download

You don't have to trust the download blindly. Every release is tied to a public
source revision, ships with a published SHA-256 checksum, and (on recent builds)
is code-signed. Here's how to check.

## 1. Verify the SHA-256 checksum

Each release publishes a `SHA256SUMS.txt` (and the hash in the release notes).
Compute the hash of your downloaded file and compare it — they must match exactly
(case doesn't matter).

**Windows (PowerShell):**
```powershell
Get-FileHash ".\OpenDescent Setup 0.5.6.exe" -Algorithm SHA256
```

**macOS / Linux:**
```bash
sha256sum OpenDescent-Setup-0.5.6.exe
# or, against the published list:
sha256sum -c SHA256SUMS.txt
```

If the hash doesn't match the published one, **do not run the file** — re-download
it, and if it still doesn't match, open an issue.

## 2. Verify the code signature (Windows)

Recent builds are signed by **Open Source Developer Alan Ivanovas** via Certum.

- **GUI:** right-click the `.exe` → **Properties** → **Digital Signatures** tab →
  select the signature → **Details**. A valid signature names the signer above.
- **PowerShell:**
  ```powershell
  Get-AuthenticodeSignature ".\OpenDescent Setup 0.5.6.exe" | Format-List Status, SignerCertificate
  ```
  `Status` should read `Valid`.

Until the signing certificate builds reputation, Windows SmartScreen may still show
a warning on first download — click **More info → Run anyway**. If a build is
*unsigned*, rely on the SHA-256 check above (or build from source).

## 3. Tie it back to the source (build it yourself)

The strongest check is to build from the exact tagged revision and compare:

```bash
git clone https://github.com/Jaguwa/OpenDescent.git
cd OpenDescent
git checkout v0.5.6          # the tag for the release you downloaded
npm ci
npm run build
npm run dist                 # produces an installer in release/
npm run checksums            # prints the SHA-256 of what you built
```

Bit-for-bit reproducible parity with the signed binary is still in progress (signing
and timestamps differ), but the unsigned build lets you confirm the code is what's
published. Each release also notes its exact commit/tag, and tagged builds run in
public CI — see the Actions tab.
