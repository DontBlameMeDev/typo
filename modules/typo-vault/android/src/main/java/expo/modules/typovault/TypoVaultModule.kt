package expo.modules.typovault

import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import android.util.Base64OutputStream
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.InputStream

class TypoVaultModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TypoVault")

    AsyncFunction("readText") Coroutine { uriString: String ->
      withContext(Dispatchers.IO) {
        open(uriString).use { it.bufferedReader(Charsets.UTF_8).readText() }
      }
    }

    AsyncFunction("readBase64") Coroutine { uriString: String, maxBytes: Long ->
      withContext(Dispatchers.IO) {
        require(maxBytes in 0..Int.MAX_VALUE.toLong()) { "Invalid file read limit." }
        val output = ByteArrayOutputStream()
        open(uriString).use { input ->
          Base64OutputStream(output, Base64.NO_WRAP).use { encoded ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var remaining = maxBytes
            while (true) {
              val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining + 1).toInt())
              if (count < 0) break
              if (count > remaining) {
                throw CodedException(
                  "ERR_TYPO_VAULT_FILE_LIMIT", "The file exceeds its read limit.", null
                )
              }
              encoded.write(buffer, 0, count)
              remaining -= count
            }
          }
        }
        output.toString("US-ASCII")
      }
    }

    AsyncFunction("listChildren") Coroutine { uriString: String ->
      withContext(Dispatchers.IO) {
        val uri = vaultUri(uriString)
        val segments = uri.pathSegments
        val documentId = if (segments.size == 4) {
          DocumentsContract.getDocumentId(uri)
        } else {
          DocumentsContract.getTreeDocumentId(uri)
        }
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri, documentId)
        val resolver = (appContext.reactContext ?: throw Exceptions.AppContextLost()).contentResolver
        val projection = arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
          DocumentsContract.Document.COLUMN_SIZE
        )
        val cursor = resolver.query(childrenUri, projection, null, null, null)
          ?: throw IllegalStateException("The document provider returned a null child cursor.")

        cursor.use {
          val idColumn = it.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
          val mimeColumn = it.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
          val sizeColumn = it.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
          val entries = mutableListOf<Map<String, Any>>()
          while (it.moveToNext()) {
            val childId = it.getString(idColumn)
            val mimeType = it.getString(mimeColumn)
            check(!childId.isNullOrEmpty()) { "The document provider returned a missing document ID." }
            check(!mimeType.isNullOrEmpty()) { "The document provider returned a missing MIME type." }
            val entry = mutableMapOf<String, Any>(
              "uri" to DocumentsContract.buildDocumentUriUsingTree(uri, childId).toString(),
              "isDirectory" to (mimeType == DocumentsContract.Document.MIME_TYPE_DIR)
            )
            if (!it.isNull(sizeColumn)) {
              val size = it.getLong(sizeColumn)
              if (size >= 0) entry["size"] = size
            }
            entries.add(entry)
          }
          entries
        }
      }
    }
  }

  private fun open(value: String): InputStream {
    val resolver = (appContext.reactContext ?: throw Exceptions.AppContextLost()).contentResolver
    return resolver.openInputStream(vaultUri(value))
      ?: throw FileNotFoundException("The document provider did not open the file.")
  }

  private fun vaultUri(value: String): Uri {
    val uri = Uri.parse(value)
    val segments = uri.pathSegments
    require(
      uri.scheme == "content" &&
        uri.authority == "com.android.externalstorage.documents" &&
        DocumentsContract.isTreeUri(uri) &&
        (segments.size == 2 ||
          (segments.size == 4 && segments[2] == "document" && segments[3].isNotEmpty())) &&
        segments[1].isNotEmpty()
    ) { "Expected a local external storage tree or tree document content URI." }
    return uri
  }
}
