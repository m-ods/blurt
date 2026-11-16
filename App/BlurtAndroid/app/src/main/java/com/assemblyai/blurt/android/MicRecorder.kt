package com.assemblyai.blurt.android

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.launch
import kotlin.math.sqrt

/**
 * Where the audio comes from: the phone's mic ([PhoneMic]) or, in Android Auto,
 * the car's ([CarMic]). Either way it is 16 kHz mono 16-bit PCM.
 */
interface PcmSource {
    /** Throws [IllegalStateException] when the microphone can't be opened. */
    fun start()

    /** Bytes read into [buffer]: 0 to try again, negative once the source has ended. */
    fun read(buffer: ByteArray): Int

    fun stop()
}

/** The phone's own microphone. Callers check RECORD_AUDIO before creating one. */
@SuppressLint("MissingPermission")
class PhoneMic : PcmSource {
    private val minBuffer = AudioRecord.getMinBufferSize(
        MicRecorder.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
    )

    // VOICE_RECOGNITION: the source tuned for speech-to-text, with no AGC or
    // noise suppression that a call would add.
    private val record = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        MicRecorder.SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBuffer, MicRecorder.FRAME_BYTES * 4),
    )

    override fun start() {
        // Another app holding the mic, or the permission revoked since the check.
        check(record.state == AudioRecord.STATE_INITIALIZED) { "The microphone isn't available" }
        record.startRecording()
    }

    // AudioRecord's errors are negative too; they mean "try again" here, not "ended".
    override fun read(buffer: ByteArray): Int = record.read(buffer, 0, buffer.size).coerceAtLeast(0)

    override fun stop() {
        if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) record.stop()
        record.release()
    }
}

/**
 * Records 16 kHz mono 16-bit PCM, exactly what the dictation route wants, so
 * the frames go on the wire untouched. Frames are 100 ms each.
 *
 * Callers check RECORD_AUDIO before starting.
 */
class MicRecorder(
    private val open: () -> PcmSource = ::PhoneMic,
    private val onLevel: (Float) -> Unit,
) {

    @Volatile private var running = false

    /** Bytes captured so far; a dictation shorter than [MIN_BYTES] is dropped. */
    @Volatile var bytesRecorded = 0L
        private set

    fun start(scope: CoroutineScope): ReceiveChannel<ByteArray> {
        val frames = Channel<ByteArray>(Channel.UNLIMITED)
        val source = open()
        running = true
        scope.launch(Dispatchers.IO) {
            try {
                source.start()
                val buffer = ByteArray(FRAME_BYTES)
                while (running && bytesRecorded < MAX_BYTES) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    bytesRecorded += read
                    frames.send(buffer.copyOf(read))
                    onLevel(level(buffer, read))
                }
                frames.close()
            } catch (e: IllegalStateException) {
                // Close the channel with the reason instead of crashing.
                frames.close(e)
            } finally {
                source.stop()
            }
        }
        return frames
    }

    /** Ends the recording; the frame channel closes once the last read lands. */
    fun stop() {
        running = false
    }

    /** RMS of the frame, scaled so normal speech sits around 0.3–0.8. */
    private fun level(buffer: ByteArray, length: Int): Float {
        var sum = 0.0
        var i = 0
        while (i + 1 < length) {
            val sample = (buffer[i].toInt() and 0xFF) or (buffer[i + 1].toInt() shl 8)
            sum += sample.toDouble() * sample
            i += 2
        }
        val rms = sqrt(sum / (length / 2).coerceAtLeast(1)) / Short.MAX_VALUE
        return (rms * 6).toFloat().coerceIn(0f, 1f)
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_BYTES = SAMPLE_RATE * 2 / 10
        // The route's limits (`SyncSTTLimits` on the Mac): 0.1 s to 1200 s.
        const val MIN_BYTES = SAMPLE_RATE * 2 / 10
        private const val MAX_BYTES = SAMPLE_RATE * 2 * 1200L
    }
}
