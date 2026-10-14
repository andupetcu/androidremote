package com.androidremote.feature.input

/** How (and whether) commands are elevated. */
enum class RootMode {
    /** Run as the app's own uid. */
    NONE,

    /** `su 0 <argv...>`: Toybox/AOSP su, executes argv directly without a shell. */
    SU_UID,

    /** `su -c "<string>"`: Magisk/SuperSU. The string IS parsed by a shell, so it is fully quoted. */
    SU_C
}

/**
 * Builds argv arrays for shell input commands. No user text is ever concatenated into a
 * shell string, except for the `su -c` mode, where each argument is POSIX single-quoted.
 */
object ShellCommands {

    /** Characters that must never reach a command line. */
    private fun isForbidden(c: Char): Boolean = c == '\n' || c == '\r' || c == '\t' || c == '\u0000'

    /**
     * Encode text as the single argument `input text` expects: control characters are
     * dropped, spaces become `%s`.
     */
    fun encodeInputText(text: String): String = buildString {
        for (c in text) {
            when {
                isForbidden(c) -> Unit
                c == ' ' -> append("%s")
                else -> append(c)
            }
        }
    }

    /** Returns null when there is nothing to type after stripping control characters. */
    fun inputText(text: String, mode: RootMode): List<String>? {
        val encoded = encodeInputText(text)
        if (encoded.isEmpty()) return null
        return wrap(listOf("input", "text", encoded), mode)
    }

    fun tap(x: Int, y: Int, mode: RootMode) = wrap(listOf("input", "tap", "$x", "$y"), mode)

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long, mode: RootMode) =
        wrap(listOf("input", "swipe", "$x1", "$y1", "$x2", "$y2", "$durationMs"), mode)

    fun keyEvent(keyCode: Int, mode: RootMode) = wrap(listOf("input", "keyevent", "$keyCode"), mode)

    fun wrap(argv: List<String>, mode: RootMode): List<String> = when (mode) {
        RootMode.NONE -> argv
        RootMode.SU_UID -> listOf("su", "0") + argv
        RootMode.SU_C -> listOf("su", "-c", argv.joinToString(" ") { shellQuote(it) })
    }

    /** POSIX single-quote quoting; safe for any character other than NUL (already stripped). */
    fun shellQuote(arg: String): String {
        // Plain words don't need quotes; keeps simple commands readable.
        if (arg.isNotEmpty() && arg.all { it.isLetterOrDigit() || it == '_' || it == '-' }) return arg
        return "'" + arg.replace("'", "'\\''") + "'"
    }

    /** Log-safe description of a command: never includes typed text. */
    fun describeForLog(command: String): String {
        val parts = command.trim().split(' ')
        return if (parts.size >= 2 && parts[0] == "input") "input ${parts[1]} (${command.length} chars)" else "command (${command.length} chars)"
    }

    fun describeForLog(argv: List<String>): String {
        val i = argv.indexOf("input")
        val sub = if (i >= 0) argv.getOrNull(i + 1) ?: "?" else "?"
        return "input $sub (${argv.size} args)"
    }
}
