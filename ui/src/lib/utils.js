import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** See desktop/renderer/src/lib/utils.js — same helper, same reasoning. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
