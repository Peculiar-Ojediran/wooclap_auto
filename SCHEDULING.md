# Scheduled Wooclap sessions

## Use

Open extension Settings → Scheduled sessions. Enter a participant event link,
choose a start date/time in the displayed local time zone, and set a duration of
1–480 minutes. Choose **Submit automatically** for unattended answering, or keep
**Review suggestions** to approve answers yourself. Add the schedule separately
from saving other settings.

At the start time the extension opens a new, inactive tab and uses the connection,
provider, model, screenshot preference, and request limit currently saved in Settings.
The schedule's answer mode and background capture apply only to this session.
If Edge has no available window but its extension process still runs, a minimized
window is created. Edge may display its debugger banner during monitoring.

At the original end time, monitoring stops and the created tab closes. Other tabs
remain open. If the created tab has been repurposed for another event or site, it
is left open. Cancel a future schedule, or use **Stop & close tab** to end one early.
Cancellation keeps the session in the list for reference. Use **Remove** to delete
an unneeded future session or a past entry from both the schedule and its history.
For a session that is starting, running, or still has its event tab, use
**Stop & remove**. This stops monitoring and closes only the tab created for that
scheduled event before removing the entry; a tab navigated away from the event
is left open. If cleanup fails, the cancelled entry remains so you can retry.

## Timing and recovery

- Keep Edge running and the computer awake. Alarms cannot launch Edge or wake a
  sleeping computer, and the browser can deliver them late.
- A delayed start runs only for the remaining scheduled time. An expired session
  is marked missed without opening a tab.
- Plans persist across browser restarts. Session-only API keys do not; use a valid
  key or configured shared service at start time. Scheduling does not change key consent.
- Overlapping plans are rejected. A session already running at the scheduled
  start is left alone, and the schedule is marked failed.
- Pausing, changing settings/keys, a navigation, or losing the debugger connection
  stops monitoring. The schedule does not silently restart it; its tab still has
  the original closing deadline.
- A worker/browser restart stops an already-started schedule without retrying
  answers. Same-browser-session ownership permits its eventual tab cleanup;
  after a browser restart, old tab IDs are never used to close restored/user tabs.
- The event may require login, a participant name, or joining manually. Scheduling
  does not fill those forms or bypass event restrictions. Unsupported questions
  and questions requiring review keep the existing extension behavior.

## Implementation and validation

Schedules and history are kept in trusted extension local storage. Tab ownership
is stored separately in session storage. Named start/end alarms plus a one-minute
recovery alarm reconcile absolute times; alarms are recreated on worker startup.
Deadline guards in the worker and content script prevent new answer application
after expiry, even if the end alarm is delayed. Existing submission claims remain
in place to avoid duplicate answers.

Run `npm run check` for unit and integration tests. Run `npm run test:schedules`
after building for an isolated Edge replay using real alarms, a local Wooclap
fixture, and synthetic AI answers. It takes about one minute and makes no paid
AI calls. Live authenticated Wooclap acceptance remains a manual check.

References: [Chromium alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms),
[Edge extension API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support).
