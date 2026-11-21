import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { createTV } from "tailwind-variants";

export const tv = createTV({ twMerge: true });

/** Joins class names and lets a later Tailwind class win over an earlier one (`cn("p-2", "p-4")` is `p-4`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Prop types that the shadcn-svelte components expect from `#lib/utils`.
export type WithoutChild<Value> = Value extends { child?: unknown } ? Omit<Value, "child"> : Value;
export type WithoutChildren<Value> = Value extends { children?: unknown } ? Omit<Value, "children"> : Value;
export type WithoutChildrenOrChild<Value> = WithoutChildren<WithoutChild<Value>>;
export type WithElementRef<Value, Other extends HTMLElement = HTMLElement> = Value & { ref?: Other | null };
