'use client';

import type { ReactNode } from 'react';
import { AgentSheet, PositionSheet, TokenSheet } from '@/components/terminal/inspect-sheets';
import { TopBar } from '@/components/terminal/top-bar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalProvider, useTerminal } from '@/lib/terminal-store';

function Gate({ children }: { children: ReactNode }) {
  const { state, stream } = useTerminal();
  if (!state.loaded) {
    return (
      <div className="grid min-h-[60vh] place-items-center font-mono text-xs text-ink-400">
        {stream === 'offline' ? 'cannot reach the engine API — is the server running?' : 'connecting to engine…'}
      </div>
    );
  }
  return <>{children}</>;
}

export default function TerminalLayout({ children }: { children: ReactNode }) {
  return (
    <TerminalProvider>
      <TooltipProvider>
        <TopBar />
        <main className="mx-auto w-full max-w-[1920px] p-2.5 lg:p-3">
          <Gate>{children}</Gate>
        </main>
        <AgentSheet />
        <TokenSheet />
        <PositionSheet />
      </TooltipProvider>
    </TerminalProvider>
  );
}
