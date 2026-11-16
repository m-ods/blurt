package com.assemblyai.blurt.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Template
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Listens as soon as it opens and stops by itself once the driver stops
 * talking, so it takes one tap, not two. Done stops it early, Back or Cancel
 * throws it away. Then the reply becomes a [CarCommand] and is carried out.
 */
class CarListenScreen(carContext: CarContext) : Screen(carContext) {

    private sealed interface Phase {
        data object Listening : Phase
        data object Working : Phase
        data class Failed(val message: String) : Phase
    }

    private var phase: Phase = Phase.Listening
    private var recorder: MicRecorder? = null
    private var upload: Deferred<DictationClient.Result>? = null
    private var startedAt = 0L

    /** When the level last rose above [SPEECH_LEVEL]; 0 until the driver says something. */
    @Volatile private var lastSpeechAt = 0L

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) = discard()
        })
        begin()
    }

    override fun onGetTemplate(): Template = when (val p = phase) {
        Phase.Listening -> MessageTemplate.Builder("Listening… Blurt stops when you do.")
            .setHeader(header("Blurt", back = true))
            .setIcon(micIcon(carContext))
            .addAction(
                Action.Builder().setTitle("Done").setFlags(Action.FLAG_PRIMARY)
                    .setOnClickListener { stopListening() }.build(),
            )
            .addAction(Action.Builder().setTitle("Cancel").setOnClickListener { screenManager.pop() }.build())
            .build()
        Phase.Working -> MessageTemplate.Builder("Working on it…")
            .setHeader(header("Blurt", back = false))
            .setLoading(true)
            .build()
        is Phase.Failed -> MessageTemplate.Builder(p.message)
            .setHeader(header("Blurt", back = true))
            .addAction(Action.Builder().setTitle("Try again").setOnClickListener { begin() }.build())
            .build()
    }

    private fun show(next: Phase) {
        phase = next
        invalidate()
    }

    private fun begin() {
        val apiKey = ApiKeyStore.load(carContext)
        if (apiKey.isNullOrBlank()) return show(Phase.Failed("Open Blurt on your phone and sign in first."))
        if (ContextCompat.checkSelfPermission(carContext, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            // Asks on the phone; the car shows a "check your phone" prompt.
            carContext.requestPermissions(listOf(Manifest.permission.RECORD_AUDIO)) { granted, _ ->
                if (Manifest.permission.RECORD_AUDIO in granted) {
                    begin()
                } else {
                    show(Phase.Failed("Blurt needs the microphone. Allow it on your phone."))
                }
            }
            return
        }
        val mic = MicRecorder(open = { CarMic(carContext) }) { level ->
            if (level > SPEECH_LEVEL) lastSpeechAt = SystemClock.elapsedRealtime()
        }
        lastSpeechAt = 0L
        startedAt = SystemClock.elapsedRealtime()
        val frames = mic.start(lifecycleScope)
        recorder = mic
        val origin = Account.dictationOrigin(carContext)
        upload = lifecycleScope.async {
            DictationClient(apiKey, CarCommand.INSTRUCTION, origin).transcribeRaw(frames, sttPrompt = "")
        }
        lifecycleScope.launch { Account.renewIfDue(carContext.applicationContext) }
        lifecycleScope.launch { stopWhenQuiet() }
        show(Phase.Listening)
    }

    /** Ends the recording a moment after speech stops, or gives up if none ever starts. */
    private suspend fun stopWhenQuiet() {
        while (phase == Phase.Listening && recorder != null) {
            delay(POLL_MS)
            val now = SystemClock.elapsedRealtime()
            val spoke = lastSpeechAt
            when {
                // The upload ended on its own: the mic failed or the network did.
                upload?.isCompleted == true -> stopListening()
                spoke == 0L && now - startedAt > NO_SPEECH_MS -> done("Didn't hear anything")
                spoke != 0L && now - spoke > SILENCE_MS -> stopListening()
            }
        }
    }

    private fun stopListening() {
        val mic = recorder ?: return
        val pending = upload ?: return
        mic.stop()
        recorder = null
        upload = null
        if (mic.bytesRecorded < MicRecorder.MIN_BYTES) {
            pending.cancel()
            return done("Didn't catch that")
        }
        show(Phase.Working)
        lifecycleScope.launch {
            try {
                val result = pending.await()
                if (result.text.isBlank()) return@launch done("Didn't catch that")
                done(carryOut(CarCommand.parse(result.rewrite, result.text)))
            } catch (e: CancellationException) {
                throw e
            } catch (e: DictationClient.KeyRejected) {
                Account.keyWasRejected(carContext.applicationContext)
                show(Phase.Failed(e.message ?: "AssemblyAI didn't accept your key"))
            } catch (e: Exception) {
                show(Phase.Failed(e.message ?: "Something went wrong"))
            }
        }
    }

    /** Does what was asked; returns what to tell the driver. */
    private fun carryOut(command: CarCommand): String = when (command) {
        is CarCommand.Note -> {
            Notes.add(carContext, command.text)
            "Saved: ${command.text.take(TOAST_PREVIEW)}"
        }
        is CarCommand.Navigate -> try {
            // The car's navigation app (Google Maps, Waze) takes over the screen.
            carContext.startCarApp(
                Intent(CarContext.ACTION_NAVIGATE, Uri.parse("geo:0,0?q=" + Uri.encode(command.destination))),
            )
            "Navigating to ${command.destination}"
        } catch (e: RuntimeException) {
            "Couldn't start navigation"
        }
        is CarCommand.Play -> MediaControl.play(carContext.applicationContext, command.query, command.app)
            ?.let { app -> "Playing ${command.query} on $app" }
            ?: "No music app could play that"
        is CarCommand.Playback -> {
            MediaControl.send(carContext, command.control)
            when (command.control) {
                CarCommand.Control.Pause -> "Paused"
                CarCommand.Control.Resume -> "Playing"
                CarCommand.Control.Next -> "Next"
                CarCommand.Control.Previous -> "Previous"
            }
        }
    }

    private fun done(message: String) {
        CarToast.makeText(carContext, message, CarToast.LENGTH_LONG).show()
        screenManager.pop()
    }

    private fun discard() {
        recorder?.stop()
        upload?.cancel()
        recorder = null
        upload = null
    }

    private companion object {
        // MicRecorder's level puts speech around 0.3–0.8; a car at speed is louder
        // than a desk, so this may need tuning on the road.
        const val SPEECH_LEVEL = 0.12f
        const val SILENCE_MS = 1_500L
        const val NO_SPEECH_MS = 8_000L
        const val POLL_MS = 150L
        const val TOAST_PREVIEW = 40
    }
}
