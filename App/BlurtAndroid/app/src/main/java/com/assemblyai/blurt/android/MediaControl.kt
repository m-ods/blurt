package com.assemblyai.blurt.android

import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.provider.MediaStore
import android.view.KeyEvent

/**
 * Music for the car's "play X" and "skip this song", without any extra
 * permission: playback controls go out as media keys (they reach whichever app
 * last played), and "play X" is Android's standard play-from-search intent,
 * which Spotify, YouTube Music and most music apps answer by starting playback.
 */
object MediaControl {

    // Asked first when the driver doesn't name an app.
    private val PREFERRED = listOf(
        "com.spotify.music",
        "com.google.android.apps.youtube.music",
        "com.amazon.mp3",
        "com.pandora.android",
        "deezer.android.app",
    )

    fun send(context: Context, control: CarCommand.Control) {
        val code = when (control) {
            CarCommand.Control.Pause -> KeyEvent.KEYCODE_MEDIA_PAUSE
            CarCommand.Control.Resume -> KeyEvent.KEYCODE_MEDIA_PLAY
            CarCommand.Control.Next -> KeyEvent.KEYCODE_MEDIA_NEXT
            CarCommand.Control.Previous -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
        }
        val audio = context.getSystemService(AudioManager::class.java)
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    /**
     * Asks a music app to play [query]: the one named [app] if it's installed,
     * else the first of [PREFERRED], else any that answers. Returns the app's
     * name, or null when no installed app plays from search.
     */
    fun play(context: Context, query: String, app: String?): String? {
        val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
            .putExtra(SearchManager.QUERY, query)
            // "Any kind of media": lets the app decide between artist, song, playlist.
            .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pm = context.packageManager
        val handlers = pm.queryIntentActivities(intent, 0)
        if (handlers.isEmpty()) return null
        fun label(i: Int) = handlers[i].loadLabel(pm).toString()
        val pick = handlers.indices.firstOrNull { app != null && label(it).lowercase().contains(app) }
            ?: PREFERRED.firstNotNullOfOrNull { pkg ->
                handlers.indices.firstOrNull { handlers[it].activityInfo.packageName == pkg }
            }
            ?: 0
        val target = handlers[pick].activityInfo
        return try {
            context.startActivity(intent.setClassName(target.packageName, target.name))
            label(pick)
        } catch (e: ActivityNotFoundException) {
            null
        } catch (e: SecurityException) {
            null
        }
    }
}
