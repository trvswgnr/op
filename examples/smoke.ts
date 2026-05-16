import { runOpExamplesSmoke } from "./op/smoke.ts";
import { runStdExamplesSmoke } from "./std/smoke.ts";

await runOpExamplesSmoke();
await runStdExamplesSmoke();
