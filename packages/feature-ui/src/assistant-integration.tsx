'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type {
  ChatProposal,
  ProposalDecisionResult,
  ResolvedCitation,
  ChatScope,
} from '@oat/services/dto/chat';

export type ProposalApplication = {
  applied(result: ProposalDecisionResult): Promise<void>;
  release(): void;
};

export type AssistantIntegration = {
  beforeSend?(scope: ChatScope): Promise<void>;
  openCitation?(citation: ResolvedCitation): boolean;
  prepareProposal?(proposal: ChatProposal): Promise<ProposalApplication | null>;
};

const Context = createContext<AssistantIntegration>({});

export function AssistantIntegrationProvider({
  value,
  children,
}: {
  value: AssistantIntegration;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useAssistantIntegration = () => useContext(Context);
