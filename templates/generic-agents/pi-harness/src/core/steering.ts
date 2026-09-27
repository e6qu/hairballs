/** Messages that reach the agent mid-run (pure). */

import type { Prompt } from "@org/agents";

export const STEER_PREFIX = "[Message from the user while you were working]";

/**
 * pi delivers a steering message as a user message after the current tool batch, before the
 * next model call. The prefix tells the model it is an interjection, not a new task.
 */
export function steeringText(prompt: Prompt): string {
  return `${STEER_PREFIX} ${prompt}`;
}
