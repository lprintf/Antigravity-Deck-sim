'use client';
import { memo } from 'react';
import { Step } from '@/lib/types';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';

export const RawJsonViewer = memo(function RawJsonViewer({ step }: { step: Step }) {
    const stepType = (step.type || '').replace('CORTEX_STEP_TYPE_', '');

    return (
        <Sheet>
            <SheetTrigger asChild>
                <button
                    className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors font-mono"
                    title="View raw JSON"
                >
                    {'{ }'}
                </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:w-[500px] sm:max-w-[500px] p-0 flex flex-col overflow-hidden">
                <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/50 shrink-0">
                    <SheetTitle className="flex items-center gap-2 text-sm">
                        <span className="text-green-400 font-mono text-xs">{'{ }'}</span>
                        <span>Raw Step JSON</span>
                    </SheetTitle>
                    <SheetDescription className="text-xs font-mono text-muted-foreground/70">
                        {stepType} · {String(step.status || '').replace('CORTEX_STEP_STATUS_', '')}
                    </SheetDescription>
                </SheetHeader>
                <ScrollArea className="flex-1 min-h-0">
                    <pre className="p-5 text-[12px] font-mono leading-relaxed text-green-300/90 whitespace-pre-wrap break-all overflow-x-auto max-w-full">
                        {JSON.stringify(step, null, 2)}
                    </pre>
                </ScrollArea>
            </SheetContent>
        </Sheet>
    );
});
RawJsonViewer.displayName = 'RawJsonViewer';
