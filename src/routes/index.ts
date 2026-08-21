import { handle as meetings } from "./meetings-routes.js";
import { handle as library } from "./library-routes.js";
import { handle as memory } from "./memory-routes.js";
import { handle as handoffs } from "./handoffs-routes.js";
import { handle as notes } from "./notes-routes.js";
import { handle as tasks } from "./tasks-routes.js";
import { handle as skills } from "./skills-routes.js";
import { handle as cloud } from "./cloud-routes.js";
import { handle as accounts } from "./accounts-routes.js";

/**
 * The per-feature route modules, tried in order after the auth gate.
 * Each returns true when it owned the request. Splitting these out of
 * server.ts is organization, not behavior: every block moved verbatim,
 * and new features add a file here instead of a hundred lines there.
 */
export const FEATURE_ROUTES = [meetings, library, memory, handoffs, notes, tasks, skills, cloud, accounts];
