package com.androidremote.app.ui

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class SecurePrefsResolverTest {

    @Test
    fun `uses the encrypted prefs when they work`() {
        val encrypted = InMemoryPrefs()
        val r = SecurePrefsResolver.resolve(create = { encrypted }, reset = { })
        assertThat(r.prefs).isSameInstanceAs(encrypted)
        assertThat(r.persistent).isTrue()
    }

    @Test
    fun `one failure resets the corrupted store and retries`() {
        val encrypted = InMemoryPrefs()
        var attempts = 0
        var resets = 0
        val r = SecurePrefsResolver.resolve(
            create = { if (attempts++ == 0) throw IllegalStateException("keystore") else encrypted },
            reset = { resets++ }
        )
        assertThat(r.prefs).isSameInstanceAs(encrypted)
        assertThat(r.persistent).isTrue()
        assertThat(resets).isEqualTo(1)
    }

    @Test
    fun `persistent failure fails closed to memory, never to a plaintext file`() {
        val r = SecurePrefsResolver.resolve(create = { throw IllegalStateException("keystore") }, reset = { })
        assertThat(r.persistent).isFalse()
        assertThat(r.prefs).isInstanceOf(InMemoryPrefs::class.java)
        // usable for the current process
        r.prefs.edit().putString("session_token", "t").apply()
        assertThat(r.prefs.getString("session_token", null)).isEqualTo("t")
    }

    @Test
    fun `in memory prefs round trip and remove`() {
        val p = InMemoryPrefs()
        p.edit().putString("a", "1").putLong("b", 2L).putBoolean("c", true).apply()
        assertThat(p.getString("a", null)).isEqualTo("1")
        assertThat(p.getLong("b", 0)).isEqualTo(2L)
        assertThat(p.getBoolean("c", false)).isTrue()
        p.edit().remove("a").apply()
        assertThat(p.contains("a")).isFalse()
    }
}
