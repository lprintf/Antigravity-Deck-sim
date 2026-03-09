import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronRight } from 'lucide-react';

export function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
    const [expanded, setExpanded] = useState(false);
    return (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 gap-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground">
                    <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                    {title}
                </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
                {children}
            </CollapsibleContent>
        </Collapsible>
    );
}
