"use client";

import { createContext, useContext } from "react";
import type { DemoDocumentPolicy } from "@/src/core";

/**
 * Deployment policy chosen by the server at request time (app/layout.tsx)
 * and handed to client components. Nothing here reads the environment.
 * Without a provider (tests, previews) the desktop behavior applies.
 */
export interface RuntimePolicy {
	demoDocuments: DemoDocumentPolicy;
}

const DESKTOP_POLICY: RuntimePolicy = { demoDocuments: "desktop" };

const RuntimePolicyContext = createContext<RuntimePolicy>(DESKTOP_POLICY);

export function RuntimePolicyProvider({ policy, children }: { policy: RuntimePolicy; children: React.ReactNode }) {
	return <RuntimePolicyContext.Provider value={policy}>{children}</RuntimePolicyContext.Provider>;
}

export function useRuntimePolicy(): RuntimePolicy {
	return useContext(RuntimePolicyContext);
}
