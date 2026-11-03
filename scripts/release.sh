#!/usr/bin/env bash
# Publish the version in app.json using the APK built by the Android workflow.
#
# Push the version bump to main, wait for the Android workflow to finish, then:
#
#   ./scripts/release.sh --no-publish   # download and check the APK only
#   ./scripts/release.sh                # download, check, tag, and publish
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLISH=1
for arg in "$@"; do
  case "$arg" in
    --no-publish) PUBLISH=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

read_app_json() {
  node -p "require('./app.json').expo$1"
}
VERSION="$(read_app_json '.version')"
CODE="$(read_app_json '.android.versionCode')"
TAG="v$VERSION"
APK="releases/typo-$VERSION.apk"
SHA="$(git rev-parse HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash before releasing." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists." >&2
  exit 1
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists." >&2
  exit 1
fi

RUN_ID="$(
  gh run list --workflow android.yml --branch main --commit "$SHA" --limit 1 \
    --json databaseId,conclusion --jq '.[0] | select(.conclusion == "success") | .databaseId'
)"
if [ -z "$RUN_ID" ]; then
  echo "No successful Android workflow for $SHA." >&2
  echo "Push the release commit to main and wait for the build." >&2
  exit 1
fi

AAPT2="${AAPT2:-}"
if [ -z "$AAPT2" ]; then
  AAPT2="$(command -v aapt2 || true)"
  if [ -z "$AAPT2" ]; then
    AAPT2="$(find "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools" -name aapt2 -type f | sort -V | tail -1)"
  fi
fi
APKSIGNER="${APKSIGNER:-}"
if [ -z "$APKSIGNER" ]; then
  APKSIGNER="$(command -v apksigner || true)"
  if [ -z "$APKSIGNER" ]; then
    APKSIGNER="$(find "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools" -name apksigner -type f | sort -V | tail -1)"
  fi
fi
if [ -z "$AAPT2" ] || [ -z "$APKSIGNER" ]; then
  echo "aapt2 and apksigner must be on PATH. The dev shell provides both." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading the APK built for $SHA"
gh run download "$RUN_ID" -n "typo-android-$SHA" -D "$TMP"

BADGING="$("$AAPT2" dump badging "$TMP/typo.apk")"
case "$BADGING" in
  *"versionCode='$CODE'"*) ;;
  *) echo "APK versionCode does not match app.json ($CODE)." >&2; exit 1 ;;
esac

CERTS="$("$APKSIGNER" verify --print-certs "$TMP/typo.apk")"
case "$CERTS" in
  *"CN=Android Debug"*)
    echo "APK is debug-signed. Add the release keystore secrets and rebuild main." >&2
    exit 1
    ;;
esac

mkdir -p releases
mv "$TMP/typo.apk" "$APK"
sha256sum "$APK"

NOTES=()
if [ -f "docs/releases/$VERSION.md" ]; then
  NOTES=(--notes-file "docs/releases/$VERSION.md")
fi

if [ "$PUBLISH" -eq 0 ]; then
  echo "Skipping publish (--no-publish). APK is at $APK."
  exit 0
fi

echo "==> Publishing $TAG"
gh release create "$TAG" --title "$TAG" "${NOTES[@]}" "$APK"
git fetch --tags --quiet
echo "Published $TAG. Add notes for the next release in docs/releases/<version>.md."
