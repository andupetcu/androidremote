# W0-ticket: shared WebSocket ticket store (contract C3)
Findings: groundwork for SS-02, SS-05, WU-02, WU-12.
Tests: server/test/wsTicketStore.test.ts (6).
RED: `TS2307: Cannot find module '../src/services/wsTicketStore'`, so 0 tests ran.
GREEN: 6 passed, 6 total.
Interface for T1 (issues tickets) and T2 (consumes them on upgrade): `wsTicketStore.issue({purpose, subject, deviceId?})`, `wsTicketStore.consume(ticket, purpose)`.
