package expo.modules.typoquicknote

import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import java.io.File

class QuickNoteTileService : TileService() {
  override fun onTileAdded() {
    super.onTileAdded()
    syncState()
  }

  // Non-active mode binds the service when the panel opens, which is where a
  // vault selected or forgotten since the last open becomes visible.
  override fun onStartListening() {
    super.onStartListening()
    syncState()
  }

  override fun onClick() {
    super.onClick()
    // Nothing to capture without a vault, and the tile reports as unavailable.
    if (!hasVault()) return
    launch(Intent(this, QuickNoteActivity::class.java))
  }

  private fun syncState() {
    val tile = qsTile ?: return
    val available = hasVault()
    tile.state = if (available) Tile.STATE_INACTIVE else Tile.STATE_UNAVAILABLE
    tile.contentDescription = getString(
      if (available) R.string.typo_quick_note_tile else R.string.typo_quick_note_tile_unavailable
    )
    tile.updateTile()
  }

  private fun hasVault(): Boolean {
    // Mirrors selectionPath() in src/vault.ts, which the app owns.
    val selection = File(filesDir, "typo-vault.json")
    return selection.isFile && selection.length() > 0
  }

  private fun launch(intent: Intent) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val pending = PendingIntent.getActivity(
        this,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ActivityOptions.makeCustomAnimation(this, 0, 0).toBundle()
      )
      startActivityAndCollapse(pending)
    } else {
      @Suppress("DEPRECATION")
      startActivityAndCollapse(intent)
    }
  }
}
