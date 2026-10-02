---
name: plan-meeting
description: Plan meetings and convert times across time zones. Use when the user is scheduling with people in different places, wants a time converted between zones, asks for overlapping working hours, or asks "what time is it for X when it is Y for me".
---

# Plan a meeting across time zones

Use the Time Zone Planner tools `convert_time`, `find_meeting_times` and `render_meeting_planner`. Explicit user instructions take priority over this skill.

## Workflow

1. Collect participants and their time zones.
   - Map a city to its IANA zone yourself (for example Lisbon to `Europe/Lisbon`).
   - If the user gives an ambiguous abbreviation (IST, CST, BST, ...) or a place with several zones, ask which one they mean before continuing.
   - Ask for a missing date only when the answer depends on it (daylight saving changes the result).
2. Convert times with `convert_time`. Never compute offsets or daylight-saving rules yourself.
3. To find meeting times, call `find_meeting_times`.
   - Defaults: 09:00-17:00 Monday to Friday for every participant, unless the user states other working hours or days.
   - The organizer is the first participant, and the search window starts at `start_date` in the organizer's zone.
   - Pass the meeting length and any working-hours overrides the user gave.
4. Offer `render_meeting_planner` for a visual grid once you know the participants and a date.
   - It takes the same participants plus one date.
   - Use it only to display; never use it to compute answers.
5. Report results clearly.
   - Show each person's local time and weekday.
   - Flag when a time falls on a different day for someone.
   - Mention any `dst_adjustment` (a time skipped or repeated by a daylight-saving change).
   - If nobody overlaps, say so plainly and present the closest partial options.
6. Do not invent availability or calendars. This plugin has no calendar access and cannot send invites; tell the user to send the invitation themselves.

## Example

User: "Can New York, Berlin and Singapore meet for 45 minutes next week?"

- Participants: `America/New_York`, `Europe/Berlin`, `Asia/Singapore`.
- Call `find_meeting_times` with the organizer first and `start_date` set to next Monday.
- Summarize the best slots with each local time, and offer the overlap grid.
