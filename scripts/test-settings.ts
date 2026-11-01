/**
 * Tests that are not about buzzer fairness pin the instant buzzer: server-arrival order and no
 * scheduled open lead, so a press right after openBuzzer() wins at once. The fair defaults
 * (device time, a 300 ms lead) are covered in buzz-fairness.test.js.
 */
export const INSTANT_BUZZER = Object.freeze({ buzzSyncMode: 'server', buzzOpenLeadMs: 0 });
