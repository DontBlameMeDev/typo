# TypoVault

Android-only local Expo module for the external-storage SAF provider. Expo autolinking finds it in `modules` without a package dependency or config plugin.

- `listChildren` queries document ID, MIME type, and size in one cursor on `Dispatchers.IO`. Unknown or negative sizes are omitted, so callers must retain the size-getter fallback.
- `readText` and `readBase64` open fresh streams on `Dispatchers.IO`, decode UTF-8 or encode base64 without line breaks, and close streams on success or failure. Base64 reads enforce the caller's byte limit while streaming, before allocating a complete file buffer.

Android enforces the app's existing SAF grant. The module requests no permissions and stores no grants or content cache. Errors propagate. Callers remain responsible for compiler preflight and actual-byte limits.

Rebuild the Android app after changing this module. Expo Go does not include it. The TypeScript bridge returns `null` only when the module is absent, allowing the existing filesystem fallback. Empty directories return `[]`.
