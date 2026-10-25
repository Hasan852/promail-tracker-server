# v2.4.3 — popup wording (user request)

- Popup track rows now lead with the open count in plain language:
  "Opened N times" (N = estimated unique opens; duplicate proxy/cache
  hits are deduped server-side). When the raw event count differs it is
  shown too ("· M tracking events"), plus the existing "via Gmail"/"direct"
  hint. The no-detection state reads "Sent — not opened yet".
- Time line: "Opened <time>" for a single open, otherwise
  "First opened <time> · Last opened <time>".
- The per-event history rows and the header disclaimer are unchanged:
  an "open" here is still a detected image load, not proof of reading.
- Also fixed: popup header in v2.4.2 still displayed "v2.4.1".

No server logic changes (version bump only). Tests: 75 passing.
