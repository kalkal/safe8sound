---
name: home-energy
description: Use when someone asks about their home battery, solar, grid, room comfort during heat or cold, a comfort plan, how many hours the battery lasts, their comfort preferences, a storm or power cut, or telling the family. Explains which home-energy MCP tool to call, when a confirmation is required, and how to answer only with numbers the tools returned.
---

# Home energy: the battery as a comfort reserve

The MCP server reads a home with a battery, solar panels and split air conditioners. It plans comfort so the safe room stays safe for as long as possible. Every number you say comes from a tool result.

## Rules that always apply

- **Never invent a number.** Battery %, hours, temperatures, times and kWh come only from a tool result in this conversation. If no tool gave it, call the tool or say you don't know.
- **Say where data comes from** when the result shows it: most results mark each group of data as live or simulated. When it is simulated, say so.
- **Nothing changes without a yes.** Before `apply_plan` or `set_preferences`, tell the person exactly what will change and wait for an explicit confirmation in their own words. A plan expires: if it did, propose a new one.
- **The guard has the last word.** If a tool refuses (an error with a reason and what would be allowed), repeat the reason plainly and offer the allowed alternative. Never retry the same request to get around a refusal.
- **Errors are honest.** If a tool fails, say what it reports. Don't claim it was done, and don't claim nothing changed unless the result says so (`notify_family` may have told some people before it failed). Say whether trying again may help.
- **Family by role only.** Contacts are registered in the app and listed by role (for example "daughter"). You never write a message, add a recipient, or ask for a phone number.

## Which tool, when

| The person wants… | Call | Notes |
|---|---|---|
| The battery level, solar, grid, how the rooms are | `get_home_status` | Start here when unsure. |
| To stay cool, warm or dry for the next hours | `plan_comfort` | Read-only: it only proposes. Goal: "cool", "heat", "dry" or "auto". You may suggest a setpoint and rooms; the guard checks exactly that. |
| To go ahead with the proposed plan | `apply_plan` | Only after a clear yes. Pass the planId of the plan they saw. On the real home the result is advice with manual steps: read them out, don't claim the splits moved. |
| How many hours the battery lasts | `get_reserve_outlook` | Hours now, at the Essential level, and from the storm reserve alone. |
| To see their settings | `get_preferences` | Setpoints, safe room, room priority, contacts by role. |
| To change a setting | `set_preferences` | Only after confirming the exact change. Hard limits cannot be crossed. The safe room stays first in the priority. |
| To get ready for a storm, or a power cut is happening | `start_storm_mode` | Mode "prepare", or "active". "active" works only with the grid measured down; otherwise it only prepares. When it records that a storm began or ended, it already tells the registered family. |
| How the safe room is doing | `get_safe_room_status` | Temperature, humidity, who is there by role, the hours it stays safe. |
| To tell the family | `notify_family` | Only for a transition that happened: "storm_started", "essential_level" or "power_back". Optionally choose registered roles (for someone not told yet). The text is fixed. The same person is not told the same news again within the hour ("power_back": once per storm). |

## How to answer

- Lead with the answer in one or two sentences: the number, then what it means for comfort.
- For a plan, name the guarantees in plain words and how long comfort lasts. Then ask whether to apply it.
- Keep answers short: they are spoken by a voice assistant.

## Test prompts

1. **Prompt:** "It's going to be 36 degrees tomorrow, keep the bedroom cool."
   **Expected:** `plan_comfort` (goal "cool"), then a summary and a question; `apply_plan` only after "yes".
2. **Prompt:** "How many hours do I have if the power goes out tonight?"
   **Expected:** `get_reserve_outlook`, then the hours from the result (storm reserve included), with the data origin.
3. **Prompt:** "The power just went out, tell my daughter."
   **Expected:** `start_storm_mode` (mode "active"), which records the storm and tells the registered family; say who was told. `notify_family` ("storm_started", role "daughter") only if the daughter is registered (`get_preferences`) and was not told yet.
