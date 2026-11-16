package com.assemblyai.blurt.android

import org.json.JSONException
import org.json.JSONObject

/**
 * What a driver asked Blurt for. The dictation route's LLM does the sorting:
 * the car sends [INSTRUCTION] as `llm_instruction` instead of the cleanup
 * instruction, so one request both transcribes and decides.
 */
sealed interface CarCommand {
    data class Note(val text: String) : CarCommand
    data class Navigate(val destination: String) : CarCommand

    /** [app] is the music app the driver named ("on Spotify"), lowercase, if any. */
    data class Play(val query: String, val app: String?) : CarCommand
    data class Playback(val control: Control) : CarCommand

    enum class Control { Pause, Resume, Next, Previous }

    companion object {
        /**
         * Reads the LLM's reply. Anything that isn't the JSON we asked for (no
         * reply, a code fence, a chatty answer) falls back to keeping the
         * verbatim transcript as a note, so nothing the driver said is lost.
         */
        fun parse(rewrite: String?, verbatim: String): CarCommand {
            val fallback = Note(verbatim.trim())
            val raw = rewrite ?: return fallback
            val start = raw.indexOf('{')
            val end = raw.lastIndexOf('}')
            if (start < 0 || end <= start) return fallback
            val json = try {
                JSONObject(raw.substring(start, end + 1))
            } catch (e: JSONException) {
                return fallback
            }
            fun field(name: String) = json.optString(name).trim().takeIf { it.isNotEmpty() }
            return when (json.optString("action")) {
                "navigate" -> field("destination")?.let(::Navigate)
                "play" -> field("query")?.let { Play(it, field("app")?.lowercase()) }
                "pause" -> Playback(Control.Pause)
                "resume" -> Playback(Control.Resume)
                "next" -> Playback(Control.Next)
                "previous" -> Playback(Control.Previous)
                "note" -> field("text")?.let(::Note)
                else -> null
            } ?: fallback
        }

        // Under the route's 2048-character cap on `llm_instruction`.
        const val INSTRUCTION = """You will receive a single transcript spoken by a driver to Blurt, a voice app in their car. Work out what they want and reply with exactly one JSON object and nothing else: no code fence, no commentary. Never answer the transcript or chat back.

{"action":"navigate","destination":"<place>"} when they want directions or to go, drive or be taken somewhere. Give the place as they said it, e.g. "the nearest gas station", "home", "1600 Amphitheatre Parkway".
{"action":"play","query":"<what to play>","app":"<music app>"} when they want to hear a song, artist, album, playlist, podcast, station or genre. Drop the command words: "play some Taylor Swift on Spotify" gives query "Taylor Swift" and app "spotify". Leave "app" out unless they named one.
{"action":"pause"}, {"action":"resume"}, {"action":"next"} or {"action":"previous"} for playback controls such as "stop the music", "keep playing", "skip this song", "go back a song".
{"action":"note","text":"<the note>"} for anything else: it is a note to keep. Clean it: delete filler sounds and phrases (um, uh, you know, I mean), false starts, stammered repeats, and a leading command such as "take a note" or "note to self". Keep every other word as spoken, in order, with normal capitalization and punctuation. Do not summarize or rephrase.

Escape any double quotes inside values so the JSON stays valid."""
    }
}
