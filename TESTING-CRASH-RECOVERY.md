# Crash recovery manual checks

These checks require the live VK application and cannot be reproduced by the local Node.js tests.

1. Enable `AVA_AUTO_CLEAN_LOOP_ON`, open the game from `vk.ru`, and verify `__AVA_CRASH_WATCHDOG_STATUS__()` in the top-page console reports `armed: true` after the first heartbeat.
2. In the game iframe console, verify `__AVA_RECOVERY_STATUS__()` reports `recoveryInProgress: false` during a normal run.
3. Start a full cycle and interrupt the game iframe while cleaning `garbage`. Confirm the top-page watchdog logs two heartbeat timeouts, saves a checkpoint, and reloads VK.
4. After reload, confirm the cleaner teleports back to `garbage`, rescans the current server state, prioritizes the interrupted stable target when it still exists, and otherwise continues without recording a failure.
5. Repeat while cleaning `garden` and during a yard-only cycle. Confirm the saved `cycleMode`, map list, and map index continue rather than restarting at map zero.
6. Trigger recovery after the work screen displays `All work here is finished`. Confirm the recovered map is skipped and the global cycle advances.
7. Cause four crashes within ten minutes. Confirm only the first three trigger automatic reloads and the parent status reports `reloadBlocked: true` after loop protection activates.
8. Navigate away from the VK game so its iframe is removed. Confirm the watchdog does not reload the page.
9. Allow healthy heartbeats for ten minutes, then verify the reload history is cleared and recovery can reload again.
10. Let the game context die while the iframe remains connected and the auto loop is in `idle`. Confirm two consecutive heartbeat timeouts trigger an immediate VK reload with reason `idle-iframe-context-dead` and without restoring the completed map.
