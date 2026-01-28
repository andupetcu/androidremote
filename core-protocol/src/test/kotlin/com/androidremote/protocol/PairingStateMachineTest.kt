package com.androidremote.protocol

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach

/**
 * Tests for the pairing protocol state machine.
 *
 * The pairing flow:
 * 1. IDLE -> generatePairingCode() -> AWAITING_CODE
 * 2. AWAITING_CODE -> onCodeEntered(correct) -> EXCHANGING_KEYS
 * 3. EXCHANGING_KEYS -> onKeyExchangeComplete() -> PAIRED
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class PairingStateMachineTest {

    private lateinit var machine: PairingStateMachine

    @BeforeEach
    fun setUp() {
        machine = PairingStateMachine()
    }

    @Test
    fun `initial state is IDLE`() {
        assertThat(machine.state).isEqualTo(PairingState.IDLE)
    }

    @Test
    fun `transitions to AWAITING_CODE after generating pairing code`() {
        val code = machine.generatePairingCode()

        assertThat(machine.state).isEqualTo(PairingState.AWAITING_CODE)
        assertThat(code).hasLength(6)
        assertThat(code).matches("[0-9]+")
    }

    @Test
    fun `pairing code is different each time`() {
        val code1 = machine.generatePairingCode()
        machine.reset()
        val code2 = machine.generatePairingCode()

        // While technically they could be the same, probability is 1 in 1 million
        // If this test flakes, we have a crypto problem
        assertThat(code1).isNotEqualTo(code2)
    }

    @Test
    fun `transitions to EXCHANGING_KEYS on valid code entry`() {
        val code = machine.generatePairingCode()

        val result = machine.onCodeEntered(code)

        assertThat(result).isTrue()
        assertThat(machine.state).isEqualTo(PairingState.EXCHANGING_KEYS)
    }

    @Test
    fun `remains AWAITING_CODE on invalid code`() {
        machine.generatePairingCode()

        val result = machine.onCodeEntered("000000") // Wrong code

        assertThat(result).isFalse()
        assertThat(machine.state).isEqualTo(PairingState.AWAITING_CODE)
    }

    @Test
    fun `increments failed attempts on invalid code`() {
        machine.generatePairingCode()

        machine.onCodeEntered("000000")

        assertThat(machine.failedAttempts).isEqualTo(1)
    }

    @Test
    fun `locks out after 3 failed attempts`() {
        machine.generatePairingCode()

        repeat(3) { machine.onCodeEntered("000000") }

        assertThat(machine.state).isEqualTo(PairingState.LOCKED_OUT)
        assertThat(machine.failedAttempts).isEqualTo(3)
    }

    @Test
    fun `cannot enter code when locked out`() {
        machine.generatePairingCode()
        val correctCode = machine.currentPairingCode

        repeat(3) { machine.onCodeEntered("000000") }
        val result = machine.onCodeEntered(correctCode!!)

        assertThat(result).isFalse()
        assertThat(machine.state).isEqualTo(PairingState.LOCKED_OUT)
    }

    @Test
    fun `transitions to PAIRED after successful key exchange`() {
        val code = machine.generatePairingCode()
        machine.onCodeEntered(code)

        val controllerPublicKey = ByteArray(32) { it.toByte() }
        machine.onKeyExchangeComplete(controllerPublicKey)

        assertThat(machine.state).isEqualTo(PairingState.PAIRED)
    }

    @Test
    fun `generates session key after successful key exchange`() {
        val code = machine.generatePairingCode()
        machine.onCodeEntered(code)

        val controllerPublicKey = ByteArray(32) { it.toByte() }
        machine.onKeyExchangeComplete(controllerPublicKey)

        assertThat(machine.sessionKey).isNotNull()
        assertThat(machine.sessionKey).hasLength(32)
    }

    @Test
    fun `pairing code expires after timeout`() {
        val shortTimeoutMachine = PairingStateMachine(codeTimeoutMs = 100)
        shortTimeoutMachine.generatePairingCode()

        Thread.sleep(150)

        assertThat(shortTimeoutMachine.isPairingCodeValid()).isFalse()
    }

    @Test
    fun `pairing code is valid before timeout`() {
        machine.generatePairingCode()

        assertThat(machine.isPairingCodeValid()).isTrue()
    }

    @Test
    fun `reset returns to IDLE state`() {
        val code = machine.generatePairingCode()
        machine.onCodeEntered(code)

        machine.reset()

        assertThat(machine.state).isEqualTo(PairingState.IDLE)
        assertThat(machine.failedAttempts).isEqualTo(0)
        assertThat(machine.currentPairingCode).isNull()
    }

    @Test
    fun `cannot generate code while already in AWAITING_CODE state`() {
        val code1 = machine.generatePairingCode()
        val code2 = machine.generatePairingCode()

        // Should return the same code, not generate a new one
        assertThat(code1).isEqualTo(code2)
    }

    @Test
    fun `stores controller public key after pairing`() {
        val code = machine.generatePairingCode()
        machine.onCodeEntered(code)

        val controllerPublicKey = ByteArray(32) { (it + 100).toByte() }
        machine.onKeyExchangeComplete(controllerPublicKey)

        assertThat(machine.controllerPublicKey).isEqualTo(controllerPublicKey)
    }
}
