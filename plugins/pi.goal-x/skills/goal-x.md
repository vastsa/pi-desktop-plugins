---
name: Goal X
description: Use when the user asks to create, track, resume, pause, revise, or complete a persistent Goal X workspace goal or an ordered Sisyphus goal.
---

# Goal X

Use Goal X only for durable work the user explicitly wants tracked. Do not create a goal merely because a request is complex.

## Tools

PI-Desktop exposes these namespaced Agent tools:

- `plugin_pi_goal_x_create_goal`
- `plugin_pi_goal_x_get_goal`
- `plugin_pi_goal_x_update_goal`
- `plugin_pi_goal_x_set_goal_tasks`
- `plugin_pi_goal_x_update_goal_task`

## Workflow

1. Read the focused goal before resuming or changing tracked work. Use the pool view when the user asks which goals are open.
2. Create a goal only after an explicit user request. Preserve ordered steps and done criteria, and use `mode: "sisyphus"` only when order is part of the request.
3. Set a concise task tree for multi-step work. Stable task ids retain progress when the plan is revised.
4. Mark a task complete only after doing the work. Supply concrete evidence when a task has a verification contract. Give a reason when skipping.
5. Keep one current task with `status: "start"` when useful. Do not mark every task complete at the end without recording progress as it occurs.
6. Call `update_goal` with `status: "complete"` only after the objective and completion contracts are satisfied. Its completion summary is a claim, not evidence; Goal X runs the configured auditor.
7. For a blocker, report the same concrete blocker only after trying reasonable alternatives. Goal X changes the goal to blocked after matching reports from three distinct turns. Pause immediately when work needs user direction but is not a repeated blocker.

Goal X persists state and evidence but cannot trigger new Agent turns on its own. Continue normally within the current turn and let the user start a later turn when more work remains.
