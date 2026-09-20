# Planner → Writer for SillyTavern

A SillyTavern UI extension that splits every reply into two stages:

1. **Plan.** The chat context (character card, persona, active lorebook entries, summary, author's
   note and the recent chat history) is sent to a *planner* connection profile. That is where you put
   the big, smart model that is good at tracking people, places and unresolved threads. It returns a
   short plan: the current situation, the beats the reply should hit, per-character state, continuity
   notes and things to avoid.
2. **Write.** The plan is injected into the prompt and your main connection, the *writer*, writes the
   actual reply. That is where you put the local model fine-tuned for prose, with whatever sampler
   settings you use to keep the slop down.

The planner never writes prose and the writer never has to reason about the whole scene on its own.

## Requirements

- SillyTavern 1.12.10 or newer with the built-in **Connection Manager** extension enabled (it is by
  default). Tested against 1.19.
- A connection profile for the planner. The writer is simply whatever your main API is set to.

## Installation

**From the Extensions panel:** open *Extensions → Install extension* and paste this repository's URL:

```
https://github.com/WillyPillow/sillytavern-planner
```

Reload the page once the install finishes.

**Manually:** copy `manifest.json`, `index.js`, `settings.html` and `style.css` into a folder named
`sillytavern-planner` under your user's extensions directory:

```
SillyTavern/data/default-user/extensions/sillytavern-planner/
```

(On older installs the directory is `public/scripts/extensions/third-party/`.) Reload the page.

## Setup

1. **Create the planner profile.** In the API connections panel, connect to the model you want to plan
   with (any chat-completion or text-completion API). Pick the sampler preset you want the planner to
   use and, for text-completion APIs, the instruct template. Then open *Connection Profiles* and
   create a profile, e.g. `Planner`. Connection profiles are just a snapshot of these settings, so
   the planner can use a completely different API, model and preset than the writer.
2. **Connect the writer.** Switch the API connections panel back to your writer model, with its own
   preset and samplers. This is the main connection SillyTavern uses for replies.
3. **Point the extension at the planner.** Open *Extensions → Planner → Writer* and choose the
   `Planner` profile in *Planner connection profile*. Leave it unselected and the current connection
   plans for itself, which is handy for testing.
4. Send a message. A toast shows while the plan is being drafted, then the reply streams in as usual.

Every reply written from a plan gets a clipboard button in its message actions (the `…` menu) that
shows the exact plan it was written from.

## Settings

**Planner**

- *Connection profile* — which profile drafts the plan.
- *Max response tokens* — response budget for the planner. Reasoning models need headroom here.
- *Planner instructions* — the planner's system prompt. Macros like `{{char}}` and `{{user}}` work.
- *Request for a normal reply / when continuing* — the final instruction appended after the context.

**Context sent to the planner**

- Toggles for the character card, user persona, active World Info entries, the Summarize extension's
  summary and the Author's Note. World Info is scanned the same way SillyTavern scans it for the
  writer, as a dry run, so timed effects such as sticky or cooldown are not disturbed.
- *Chat history format* — one transcript block inside a single user message (robust for every API
  and the default) or separate user/assistant messages.
- *Max history messages* and *History token budget* — how much history the planner sees. With both at
  zero the planner gets as much history as fits the writer's context size. Set a bigger token budget
  if the planner model has a bigger context than the writer, which is usually the point.

**Injecting the plan into the writer prompt**

- *Injection template* — `{{plan}}` is replaced with the plan. Macros work in the rest of the text.
- *Position / Depth / Role* — where the plan goes. The default, in chat at depth 0 as a system
  message, puts it right before the writer's turn. For chat-completion writers you can also inject it
  before or after the main prompt; those entries show up in the prompt manager as extension prompts.

**Behavior**

- *Reuse the previous plan on swipe / regenerate* — off by default, so each swipe gets a fresh plan.
  Turn it on to keep the plan and only vary the prose.
- *Also plan when continuing a reply* — off by default.
- *If the planner fails* — write without a plan (default) or abort the generation.
- *Store each plan on the reply it produced* — powers the clipboard button. Plans are saved in the
  message's `extra` data and per swipe, so they survive reloads.

**Plan**

- *Guidance for the planner (this chat only)* — free text appended to every planner request for this
  chat, like an author's note that only the planner sees. Saved in the chat's metadata.
- *Current plan* — the latest plan. Edit it and press *Use for next reply* to pin it: the next reply
  uses the pinned text instead of calling the planner. *Draft plan now* runs the planner without
  generating a reply.

## Slash commands and macros

| Command | What it does |
| --- | --- |
| `/plan [guidance]` | Runs the planner on the current chat and returns the plan. Unnamed text is one-off guidance. |
| `/plan use=true [guidance]` | Same, and pins the result for the next reply. |
| `/plan-set <text>` | Pins your own plan for the next reply; the planner is skipped for that reply. |
| `/plan-clear` | Unpins the pending plan. |
| `/planner on\|off` | Turns the extension on or off; no argument toggles. Returns the new state. |

`{{lastPlan}}` expands to the most recent plan anywhere macros are allowed.

Example: `/plan use=true The stranger finally hands over the letter | /echo`

## How it works

The extension registers a generation interceptor, which SillyTavern runs before it builds the
prompt for any non-dry-run generation. The interceptor skips quiet prompts and impersonation, builds
the planner request from the same message list SillyTavern is about to use, sends it through
`ConnectionManagerRequestService`, and registers the plan as an extension prompt. SillyTavern then
builds the writer prompt with that injection in place. The injection is cleared as soon as the prompt
has been assembled, so a plan can never leak into a later prompt, a summary or a quiet command.

Stopping a generation while the planner is running cancels the planner request and aborts the
generation.

Everything goes through `SillyTavern.getContext()`, so the extension does not import from
SillyTavern's internal module paths.

## Tips

- Chat-completion planners with a large context are the natural fit: raise the history token budget
  so the planner sees far more of the story than the writer can.
- If the planner is a text-completion API, set an instruct template on its profile. Without one the
  planner messages are just concatenated.
- Keep the planner's response short. The default instructions ask for under 300 words; long plans
  crowd out chat history in a small writer context.
- The Summarize extension pairs well with this: the summary is included in the planner context, so
  long-running chats stay coherent even when the writer only sees recent messages.
- To see exactly what the planner received and returned, open the browser console; both are logged
  at debug level.

## License

MIT. See [LICENSE](LICENSE).
