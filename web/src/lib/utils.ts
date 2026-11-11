import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { createTV } from "tailwind-variants";

export const tv = createTV({ twMerge });

/** Joins class names and lets a later Tailwind class win over an earlier one (`cn("p-2", "p-4")` is `p-4`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Prop types that the shadcn-svelte components expect from `#lib/utils`.
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
