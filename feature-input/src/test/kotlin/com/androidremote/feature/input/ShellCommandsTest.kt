package com.androidremote.feature.input

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class ShellCommandsTest {

    @Test
    fun `text is a single argv element, never a shell string`() {
        val argv = ShellCommands.inputText("hello; reboot", RootMode.SU_UID)!!
        assertThat(argv).containsExactly("su", "0", "input", "text", "hello;%sreboot").inOrder()
        assertThat(argv).doesNotContain("sh")
        assertThat(argv).doesNotContain("-c")
    }

    @Test
    fun `semicolon reboot payload stays one argument`() {
        val argv = ShellCommands.inputText("x; reboot", RootMode.NONE)!!
        assertThat(argv.take(3)).containsExactly("input", "text", "x;%sreboot").inOrder()
        assertThat(argv).hasSize(3)
    }

    @Test
    fun `newline carriage return tab and NUL are stripped`() {
        val argv = ShellCommands.inputText("a\nsettings put global adb_enabled 1\r\tb\u0000c", RootMode.NONE)!!
        assertThat(argv).hasSize(3)
        val arg = argv[2]
        assertThat(arg).doesNotContain("\n")
        assertThat(arg).doesNotContain("\r")
        assertThat(arg).doesNotContain("\t")
        assertThat(arg).doesNotContain("\u0000")
        assertThat(arg).isEqualTo("asettings%sput%sglobal%sadb_enabled%s1bc")
    }

    @Test
    fun `spaces become percent s`() {
        assertThat(ShellCommands.encodeInputText("a b  c")).isEqualTo("a%sb%s%sc")
    }

    @Test
    fun `text with only control characters yields no command`() {
        assertThat(ShellCommands.inputText("\n\r\t", RootMode.NONE)).isNull()
        assertThat(ShellCommands.inputText("", RootMode.NONE)).isNull()
    }

    @Test
    fun `su dash c mode single-quotes the whole command`() {
        val argv = ShellCommands.inputText("it's \$(reboot) `id` ; *", RootMode.SU_C)!!
        assertThat(argv.take(2)).containsExactly("su", "-c").inOrder()
        assertThat(argv).hasSize(3)
        // everything user-controlled sits inside single quotes with ' escaped as '\''
        assertThat(argv[2]).isEqualTo("input text 'it'\\''s%s\$(reboot)%s`id`%s;%s*'")
    }

    @Test
    fun `typed commands are built from integers only`() {
        assertThat(ShellCommands.tap(10, 20, RootMode.NONE)).containsExactly("input", "tap", "10", "20").inOrder()
        assertThat(ShellCommands.swipe(1, 2, 3, 4, 500L, RootMode.SU_UID))
            .containsExactly("su", "0", "input", "swipe", "1", "2", "3", "4", "500").inOrder()
        assertThat(ShellCommands.keyEvent(66, RootMode.NONE)).containsExactly("input", "keyevent", "66").inOrder()
    }

    @Test
    fun `redaction of text for logs hides content`() {
        assertThat(ShellCommands.describeForLog("input text secret")).doesNotContain("secret")
    }
}
