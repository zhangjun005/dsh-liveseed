// Development acceptance only. Never mounted by the shipped bundle.
import { FixtureAdapter } from './fixture.mjs';
export const name = 'liveseed-test-model';
export const inject = ['llm'];
export function apply(ctx) { ctx.llm.registerAdapter(['fixture'], new FixtureAdapter()); }
