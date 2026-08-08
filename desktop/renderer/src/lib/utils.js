import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones.
 * clsx handles conditionals; twMerge resolves conflicts like "p-2 p-4" that
 * clsx would happily emit both of.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
