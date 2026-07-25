---
name: design
description: Anti-generic-AI design entry point; use FIRST for any UI, frontend, or visual work: websites, pages, components, apps, or redesigns.
---

# Design that does not read as AI-made

Default model output has a look: safe spacing, stock layout, the same three fonts, the same purple gradient. This capability is a retrieval system that pushes past that default so the result looks intentional and human-made. Enter here before you write any markup.

## When to reach for this
- You are building or reshaping any user interface: a website, a page, a component, an app shell.
- You are about to reach for a familiar default layout and want something with a point of view instead.
- The work is visual, and "it looks generic" would count as a failure.

## The workflow
1. **Call `design_core` FIRST, and treat what it returns as the standard.**
   - It gives you the non-negotiables: the principle behind why AI design reads as AI, the formatting laws that hold a layout together, and the build rules to follow.
   - Review it before writing markup, and keep it in view as you build.
2. **Pull `design_layer` on demand for depth.** Request the layer that matches the decision in front of you:
   - `donts`: the specific tells to avoid, the patterns that mark work as machine-made.
   - `formatting`: the layout laws that keep spacing, rhythm, and alignment coherent.
   - `directives`: the active instructions to apply while composing.
   - `scaffolds`: occupancy-correct page skeletons to build on, so the page fills its space correctly instead of floating centered in a void.
   - `type_pointers`: typography direction, pairing, and scale.
3. **Handle imagery deliberately.**
   - If your client has native image generation, use it.
   - Otherwise use `generate_image` only when it is actually surfaced as an alternate engine.
   - Iterate the still until it is right BEFORE you animate anything. Motion multiplies the cost of a bad frame.
4. **Hold the non-negotiables until it ships.** The rules from `design_core` are constraints, not suggestions. Do not relax them because iteration got tedious; that is exactly when generic creeps back in.

## What you are carrying past the default
`design_core` and its layers are the source of truth. As a reminder of the shape they hold you to:
- A real point of view in type, color, and layout, not the safe middle of every axis.
- Correct occupancy: the page fills its space with intent, with no lonely centered column in a sea of white.
- Rhythm and alignment that hold across breakpoints, not spacing chosen ad hoc per section.
- Imagery that belongs to the design, not stock filler dropped into a slot.

## Keep iterations honest
- Change one dimension at a time (type, color, layout, or motion) so you can tell what actually improved.
- After each pass, check the result against the tells in the `donts` layer, not just against your own taste.
- Ship only when nothing on the page matches a known AI tell.

## Sequence, in short
1. `design_core` for the standard.
2. `design_layer` for the specific decision in front of you.
3. Build against a scaffold, never a blank page.
4. Imagery: native generation first. Never delegate back into the same host CLI merely to reach an image model; use an exposed alternate engine only when intentionally selected. Load expensive design layers once and reuse them; the still before any motion.
5. Check the result against `donts`, then ship.

## If the RAG is not installed
- If `design_core` reports the design content is not installed, say so plainly to the user.
- Then continue with your best design judgment. Do not invent a substitute "standard" and present it as the vibecoders one.

## Red flags
Stop if you catch yourself doing any of these:
- Writing markup before you called `design_core`.
- Reaching for the default centered hero, the stock three-column cards, or the safe gradient.
- Animating a still you have not made right yet.
- Relaxing the non-negotiables mid-iteration because they felt strict.
- Papering over a missing RAG with a made-up standard instead of naming the gap.
- Calling it done while a section still looks like a template.
