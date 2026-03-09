'use client';

export function StreamingIndicator() {
    return (
        <div className="flex justify-start mb-4">
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg rounded-bl-md bg-purple-950/10 border border-purple-500/10">
                <div className="flex gap-1">
                    <div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-xs text-purple-400/70">Agent is working...</span>
            </div>
        </div>
    );
}
