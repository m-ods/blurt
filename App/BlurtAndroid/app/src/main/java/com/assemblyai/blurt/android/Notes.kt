package com.assemblyai.blurt.android

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Voice notes, newest first, in one small JSON file in the app's private
 * storage. The car app adds them and the phone app shows them; both run in
 * the same process, so one [StateFlow] keeps them in step.
 */
object Notes {
    data class Note(val id: Long, val text: String)

    private const val FILE = "notes.json"
    private const val CAP = 500

    private val _all = MutableStateFlow<List<Note>>(emptyList())
    private var loaded = false

    fun all(context: Context): StateFlow<List<Note>> {
        load(context)
        return _all
    }

    @Synchronized
    fun add(context: Context, text: String): Note {
        load(context)
        val note = Note(System.currentTimeMillis(), text)
        save(context, (listOf(note) + _all.value).take(CAP))
        return note
    }

    @Synchronized
    fun delete(context: Context, id: Long) {
        load(context)
        save(context, _all.value.filterNot { it.id == id })
    }

    @Synchronized
    private fun load(context: Context) {
        if (loaded) return
        loaded = true
        val file = file(context)
        if (!file.exists()) return
        _all.value = try {
            val array = JSONArray(file.readText())
            List(array.length()) { i ->
                val json = array.getJSONObject(i)
                Note(json.getLong("id"), json.getString("text"))
            }
        } catch (e: org.json.JSONException) {
            emptyList()
        }
    }

    private fun save(context: Context, notes: List<Note>) {
        val array = JSONArray()
        notes.forEach { array.put(JSONObject().put("id", it.id).put("text", it.text)) }
        // Write-then-rename, so a crash mid-write never leaves half a file.
        val file = file(context)
        val tmp = File(file.parentFile, "$FILE.tmp")
        tmp.writeText(array.toString())
        tmp.renameTo(file)
        _all.value = notes
    }

    private fun file(context: Context) = File(context.filesDir, FILE)
}
