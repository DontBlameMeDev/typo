package expo.modules.typoquicknote

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.ReactActivity
import java.lang.ref.WeakReference

class QuickNoteActivity : ReactActivity() {
  override fun getMainComponentName(): String = "quickNote"

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    instance = WeakReference(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      )
    }
  }

  override fun onDestroy() {
    if (instance?.get() === this) instance = null
    super.onDestroy()
  }

  // Back closes the popup instead of sending its task to the background.
  override fun invokeDefaultOnBackPressed() {
    finish()
  }

  companion object {
    private var instance: WeakReference<QuickNoteActivity>? = null

    // A save can complete after another activity is resumed. Only the sheet
    // that started it should close.
    fun finishCurrent() {
      instance?.get()?.finish()
    }
  }
}
