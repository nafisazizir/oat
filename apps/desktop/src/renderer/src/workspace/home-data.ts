import { createContext } from 'react';
import type { HomeDocument } from '@oat/workspace-ui/home-model';

export const DesktopHomeData = createContext<{
  documents: HomeDocument[];
  loading: boolean;
  error: string | null;
  retry(): void;
}>({ documents: [], loading: true, error: null, retry() {} });
