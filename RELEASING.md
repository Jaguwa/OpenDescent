# Release process

Every release is tied to an exact tag/commit, ships a published SHA-256 checksum,
and is signed locally. This is the checklist.

## 1. Bump version + notes
- `package.json` → `version`.
- Add `RELEASE_NOTES_<x.y.z>.md` (copy the previous one, edit the "What's New").
- Commit: `git commit -am "x.y.z: <summary>"`.

## 2. Build + sign the installer
```powershell
npm run build
npm run dist        # electron-builder --win, signs via the Certum cert in the Windows store
```
Output: `release/OpenDescent Setup <x.y.z>.exe`.

> Signing needs the Certum cert (and its token/PIN), so this step is run locally,
> not in CI. CI produces an *unsigned* transparency build of the same tag.

## 3. Generate checksums
```powershell
npm run checksums   # writes release/SHA256SUMS.txt
```

## 4. Tag the exact revision
```bash
git tag v<x.y.z>            # tags the commit the release is built from
git push origin master --tags
```

## 5. Publish the GitHub Release
- Create a release from tag `v<x.y.z>`.
- Upload `OpenDescent Setup <x.y.z>.exe` **and** `SHA256SUMS.txt`.
- Paste the release notes, and include the SHA-256 + the source commit in the body:
  `Built from <commit-sha> (tag v<x.y.z>).`

## 6. Bump + deploy the marketing site
- Bump version refs in `frontend/` (download links, labels, banner, changelog) and commit.
- Deploy (nginx doc root via rsync — see notes in the deploy docs):
  ```bash
  ssh root@188.166.151.203
  cd /root/OpenDescent && git pull origin master
  rsync -av --exclude='/index.html' --exclude='app.js' --exclude='style.css' \
    --exclude='audio-capture-worklet.js' --exclude='audio-playback-worklet.js' \
    --exclude='icons/' --exclude='og-image.html' \
    /root/OpenDescent/frontend/ /var/www/open-descent/
  ```
  Deploy the site **after** the GitHub release is up — the download buttons point at it.

## Order
1 → 2 → 3 → 4 → 5 → 6. The site goes live last so download links never 404.
