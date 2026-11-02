#!/usr/bin/env bash
# Build, sign, and publish the version in app.json to Codeberg releases.
#
# Configuration comes from .env in the repo root:
#   KEYSTORE=.keys/typo.jks
#   KEYSTORE_PASSWORD=...
#   KEY_ALIAS=typo
#
#   ./scripts/release.sh --no-publish   # build and sign only
#   ./scripts/release.sh                # build, sign, tag, and publish
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

KEYSTORE="${KEYSTORE:-.keys/typo.jks}"
: "${KEYSTORE_PASSWORD:?set KEYSTORE_PASSWORD in .env}"
if [ ! -f "$KEYSTORE" ]; then
  echo "Keystore $KEYSTORE does not exist. Set KEYSTORE in .env." >&2
  exit 1
fi
ALIAS="${KEY_ALIAS:-typo}"
ARCHS="${ARCHS:-arm64-v8a,x86_64}"
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

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash before releasing." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists." >&2
  exit 1
fi
if fj release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists." >&2
  exit 1
fi

APKSIGNER="${APKSIGNER:-$(command -v apksigner || true)}"
AAPT2="${AAPT2:-}"
if [ -z "$AAPT2" ]; then
  AAPT2="$(command -v aapt2 || true)"
  if [ -z "$AAPT2" ]; then
    AAPT2="$(find "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools" -name aapt2 -type f | sort -V | tail -1)"
  fi
fi
if [ -z "$APKSIGNER" ] || [ -z "$AAPT2" ]; then
  echo "apksigner and aapt2 must be on PATH. The dev shell provides both." >&2
  exit 1
fi

echo "==> Building Typo $VERSION ($CODE)"
bun run build:web
npx expo prebuild -p android --clean
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures="$ARCHS")

echo "==> Signing $APK"
mkdir -p releases
cp android/app/build/outputs/apk/release/app-release.apk "$APK"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias "$ALIAS" \
  --ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEYSTORE_PASSWORD "$APK"
"$APKSIGNER" verify --print-certs "$APK" | sed -n '1,3p'
sha256sum "$APK"

BADGING="$("$AAPT2" dump badging "$APK")"
case "$BADGING" in
  *"versionCode='$CODE'"*) ;;
  *) echo "APK versionCode does not match app.json ($CODE)." >&2; exit 1 ;;
esac

NOTES=()
if [ -f "docs/releases/$VERSION.md" ]; then
  NOTES=(-b "$(cat "docs/releases/$VERSION.md")")
fi

if [ "$PUBLISH" -eq 0 ]; then
  echo "Skipping publish (--no-publish). Signed APK is at $APK."
  exit 0
fi

echo "==> Publishing $TAG"
fj release create "$TAG" -T -a "$APK" "${NOTES[@]}"
git fetch --tags --quiet
echo "Published $TAG. Add notes for the next release in docs/releases/<version>.md."
