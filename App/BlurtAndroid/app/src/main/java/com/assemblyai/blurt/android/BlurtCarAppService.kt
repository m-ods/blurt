package com.assemblyai.blurt.android

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.text.format.DateUtils
import androidx.car.app.CarAppService
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.media.CarAudioRecord
import androidx.car.app.model.Action
import androidx.car.app.model.CarIcon
import androidx.car.app.model.Header
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.validation.HostValidator
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Blurt in Android Auto: one big "Talk" button on the car's screen. Speak, and
 * Blurt keeps it as a note, starts navigation, or plays music ([CarCommand]).
 * Templates only, as Android Auto requires; the screens are below and in
 * [CarListenScreen].
 */
class BlurtCarAppService : CarAppService() {

    // A debug build talks to any host, so the Desktop Head Unit works; a
    // release build only to Google's (Android Auto's) signed hosts.
    override fun createHostValidator(): HostValidator =
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            HostValidator.Builder(this)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }

    override fun onCreateSession(): Session = object : Session() {
        override fun onCreateScreen(intent: Intent): Screen = CarHomeScreen(carContext)
    }
}

/** The car's microphone, which Android Auto hands over in the same 16 kHz mono PCM as the phone's. */
@SuppressLint("MissingPermission") // CarListenScreen checks RECORD_AUDIO first.
class CarMic(carContext: CarContext) : PcmSource {
    private val record = CarAudioRecord.create(carContext)

    override fun start() = record.startRecording()

    override fun read(buffer: ByteArray): Int = record.read(buffer, 0, buffer.size)

    override fun stop() = record.stopRecording()
}

internal fun micIcon(carContext: CarContext): CarIcon =
    CarIcon.Builder(IconCompat.createWithResource(carContext, R.drawable.ic_mic)).build()

internal fun header(title: String, back: Boolean): Header =
    Header.Builder().setTitle(title).apply { if (back) setStartHeaderAction(Action.BACK) }.build()

/** Home: Talk, then the latest notes. */
class CarHomeScreen(carContext: CarContext) : Screen(carContext) {

    init {
        // A note saved from the listen screen shows up here on the way back.
        lifecycleScope.launch { Notes.all(carContext).collect { invalidate() } }
    }

    override fun onGetTemplate(): Template {
        val mic = micIcon(carContext)
        val talk = { screenManager.push(CarListenScreen(carContext)) }
        // Android Auto caps list length while driving (often 6); Talk takes one row.
        val limit = carContext.getCarService(ConstraintManager::class.java)
            .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
        val items = ItemList.Builder().addItem(
            Row.Builder()
                .setTitle("Talk to Blurt")
                .addText("Take a note, navigate somewhere, or play music")
                .setImage(mic)
                .setOnClickListener(talk)
                .build(),
        )
        Notes.all(carContext).value.take(limit - 1).forEach { note ->
            items.addItem(
                Row.Builder()
                    .setTitle(note.text)
                    .addText(DateUtils.getRelativeTimeSpanString(note.id))
                    .setOnClickListener { screenManager.push(CarNoteScreen(carContext, note)) }
                    .build(),
            )
        }
        return ListTemplate.Builder()
            .setHeader(
                Header.Builder()
                    .setTitle("Blurt")
                    .setStartHeaderAction(Action.APP_ICON)
                    .addEndHeaderAction(Action.Builder().setTitle("Talk").setIcon(mic).setOnClickListener(talk).build())
                    .build(),
            )
            .setSingleList(items.build())
            .build()
    }
}

/** One note, with Delete. */
class CarNoteScreen(carContext: CarContext, private val note: Notes.Note) : Screen(carContext) {
    override fun onGetTemplate(): Template =
        MessageTemplate.Builder(note.text)
            .setHeader(header(DateUtils.getRelativeTimeSpanString(note.id).toString(), back = true))
            .addAction(
                Action.Builder()
                    .setTitle("Delete")
                    .setOnClickListener {
                        Notes.delete(carContext, note.id)
                        CarToast.makeText(carContext, "Deleted", CarToast.LENGTH_SHORT).show()
                        screenManager.pop()
                    }
                    .build(),
            )
            .build()
}
