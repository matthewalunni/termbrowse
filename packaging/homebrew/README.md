# Homebrew

`termbrowse.rb` is the formula for the tap `matthewalunni/tap`. Users install it with:

```sh
brew install matthewalunni/tap/termbrowse
```

Homebrew finds that tap in the GitHub repository `matthewalunni/homebrew-tap`, at `Formula/termbrowse.rb`. The formula installs the npm tarball with Homebrew's own Node (`depends_on "node"`), so users don't need Node beforehand.

## Releasing a new version

1. Publish to npm first (`npm publish`; `prepublishOnly` runs the tests).
2. Get the published tarball's checksum:

   ```sh
   curl -sL https://registry.npmjs.org/termbrowse/-/termbrowse-X.Y.Z.tgz | shasum -a 256
   ```

3. In `termbrowse.rb`, set `url` to that tarball and `sha256` to the checksum. Commit it here, then copy it to `Formula/termbrowse.rb` in `matthewalunni/homebrew-tap` and push.
4. Check it: `brew update && brew upgrade termbrowse && brew test termbrowse`.

## Testing the formula before a release

`brew` isn't needed locally; the official image works. (On Linux, use `sha256sum` where this says `shasum -a 256`.) Pack the tarball, point a copy of the formula at it, and install that from a local tap:

```sh
npm pack --pack-destination /tmp/tb
sed -e 's|^  url .*|  url "file:///work/termbrowse-X.Y.Z.tgz"|' \
    -e "s|^  sha256 .*|  sha256 \"$(shasum -a 256 /tmp/tb/termbrowse-X.Y.Z.tgz | cut -d' ' -f1)\"|" \
    packaging/homebrew/termbrowse.rb > /tmp/tb/termbrowse.rb
docker run --rm -v /tmp/tb:/work homebrew/brew:latest bash -c '
  brew update >/dev/null &&   # the image ships stale metadata; installing node fails without this
  brew tap-new --no-git local/tb >/dev/null &&
  cp /work/termbrowse.rb "$(brew --repository local/tb)/Formula/" &&
  brew install local/tb/termbrowse && brew test local/tb/termbrowse &&
  brew audit --formula local/tb/termbrowse && termbrowse --version'
```
