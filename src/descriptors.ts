// SPDX-License-Identifier: GPL-3.0-only

import type { JsonPrimitive, ProductField } from "@elqora/dgp-spec";

export interface AuthoringChildOptionCapability {
  supported?: boolean;
  auto_create?: boolean;
  default_label?: string;
  default_value?: JsonPrimitive;
}

export interface AuthoringOptionCapability {
  supported?: boolean;
  auto_create?: boolean;
  default_label?: string;
  default_value?: JsonPrimitive;
  children?: AuthoringChildOptionCapability;
}

export interface AuthoringMultiCapability {
  supported?: boolean;
  auto_enable?: boolean;
}

export interface AuthoringFieldDescriptor {
  type: string;
  variant?: string;
  defaults?: ProductField["defaults"];
  ui?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  options?: AuthoringOptionCapability;
  multi?: AuthoringMultiCapability;
  meta?: Readonly<Record<string, unknown>>;
}

export interface AuthoringDescriptorRegistry {
  register(descriptor: AuthoringFieldDescriptor): void;
  unregister(type: string, variant?: string): void;
  resolve(type: string, variant?: string): AuthoringFieldDescriptor | undefined;
}

export function createAuthoringDescriptorRegistry(
  initial: readonly AuthoringFieldDescriptor[] = [],
): AuthoringDescriptorRegistry {
  const key = (type: string, variant: string): string => `${type}\u0000${variant}`;
  const entries = new Map(initial.map((descriptor) => [key(descriptor.type, descriptor.variant ?? "default"), structuredClone(descriptor)]));
  return {
    register(descriptor) { entries.set(key(descriptor.type, descriptor.variant ?? "default"), structuredClone(descriptor)); },
    unregister(type, variant = "default") { entries.delete(key(type, variant)); },
    resolve(type, variant = "default") {
      const descriptor = entries.get(key(type, variant)) ?? entries.get(key(type, "default"));
      return descriptor === undefined ? undefined : structuredClone(descriptor);
    },
  };
}
