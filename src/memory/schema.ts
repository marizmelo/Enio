import { z } from "zod";

/**
 * The single most important design decision in this project.
 *
 * Open-ended "extract any triples you see" prompting produces garbage from a
 * ~1B-active model: inconsistent relation names (USES / uses / USES_TOOL /
 * is_using), entities that are really sentences, and duplicates that never
 * merge. A graph built that way degrades as it grows.
 *
 * Constraining extraction to a small closed vocabulary turns an open generation
 * problem into something much closer to classification, which small models are
 * substantially better at. The cost is that anything outside the vocabulary is
 * invisible to the graph — which is why `facts` exists alongside it as a free-text
 * escape hatch.
 *
 * Keep these lists SHORT. Every added relation measurably increases confusion.
 */

export const ENTITY_TYPES = [
  "person",
  "project",
  "technology",
  "organization",
  "place",
  "concept",
] as const;

export const RELATIONS = [
  "WORKS_ON",
  "USES",
  "PREFERS",
  "AVOIDS",
  "KNOWS",
  "PART_OF",
  "LOCATED_IN",
  "LEARNING",
  "BLOCKED_BY",
] as const;

export const entitySchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(ENTITY_TYPES),
});

export const tripleSchema = z.object({
  subject: z.string().min(1).max(80),
  subject_type: z.enum(ENTITY_TYPES),
  relation: z.enum(RELATIONS),
  object: z.string().min(1).max(80),
  object_type: z.enum(ENTITY_TYPES),
});

export const extractionSchema = z.object({
  triples: z.array(tripleSchema).max(20),
});

export type Triple = z.infer<typeof tripleSchema>;

export const RELATION_LIST = RELATIONS.join(", ");
export const ENTITY_TYPE_LIST = ENTITY_TYPES.join(", ");
