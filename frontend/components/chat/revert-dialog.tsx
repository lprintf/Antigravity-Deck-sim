'use client';
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { getRevertPreview, revertToCascadeStep, RevertPreview } from '@/lib/cascade-api';
import { RotateCcw, FileWarning, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';

interface RevertDialogProps {
    cascadeId: string;
    stepIndex: number;
    onClose: () => void;
    onReverted: () => void;
}

export function RevertDialog({ cascadeId, stepIndex, onClose, onReverted }: RevertDialogProps) {
    const [preview, setPreview] = useState<RevertPreview | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reverting, setReverting] = useState(false);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getRevertPreview(cascadeId);
                if (!cancelled) { setPreview(data); setLoading(false); }
            } catch (e: any) {
                if (!cancelled) { setError(e.message); setLoading(false); }
            }
        })();
        return () => { cancelled = true; };
    }, [cascadeId]);

    const handleRevert = useCallback(async () => {
        setReverting(true);
        setError(null);
        try {
            await revertToCascadeStep(cascadeId, stepIndex);
            setSuccess(true);
            setTimeout(() => {
                onReverted();
                onClose();
            }, 1000);
        } catch (e: any) {
            setError(e.message);
            setReverting(false);
        }
    }, [cascadeId, stepIndex, onReverted, onClose]);

    // Extract file name from URI path
    const getFileName = (uri?: string) => {
        if (!uri) return 'unknown';
        const decoded = decodeURIComponent(uri);
        const parts = decoded.replace(/^file:\/\//, '').split('/');
        return parts[parts.length - 1] || decoded;
    };
    const getRelPath = (uri?: string) => {
        if (!uri) return '';
        const decoded = decodeURIComponent(uri).replace(/^file:\/\//, '');
        // Take last 3 segments
        const parts = decoded.split('/');
        return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : decoded;
    };

    const files = preview?.filesToRevert || [];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div
                className="relative w-full max-w-md mx-4 bg-background border border-border rounded-xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/50 bg-amber-500/5">
                    <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-amber-500/20 flex items-center justify-center">
                            <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold">Revert to Step #{stepIndex + 1}</h3>
                            <p className="text-[10px] text-muted-foreground/60">Roll back conversation and code changes</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1 rounded hover:bg-muted/30 text-muted-foreground/40 hover:text-muted-foreground">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="px-5 py-4 max-h-[50vh] overflow-y-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-8 text-muted-foreground/50">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" />
                            <span className="text-sm">Loading preview…</span>
                        </div>
                    ) : success ? (
                        <div className="flex flex-col items-center py-8 text-emerald-400 gap-2">
                            <CheckCircle2 className="h-8 w-8" />
                            <span className="text-sm font-medium">Reverted successfully!</span>
                        </div>
                    ) : (
                        <>
                            {error && (
                                <div className="flex items-center gap-2 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                                    <AlertTriangle className="h-4 w-4 shrink-0" />
                                    <span>{error}</span>
                                </div>
                            )}

                            {files.length > 0 ? (
                                <>
                                    <p className="text-xs text-muted-foreground/70 mb-3">
                                        The following <span className="font-semibold text-amber-400">{files.length}</span> file{files.length !== 1 ? 's' : ''} will be affected:
                                    </p>
                                    <div className="space-y-1">
                                        {files.map((f, i) => (
                                            <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/20 border border-border/30">
                                                <FileWarning className="h-3.5 w-3.5 text-amber-400/70 shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                    <span className="text-xs font-mono text-foreground/80 truncate block">
                                                        {getFileName(f.absolutePathUri || f.relativePath)}
                                                    </span>
                                                    <span className="text-[9px] font-mono text-muted-foreground/40 truncate block">
                                                        {getRelPath(f.absolutePathUri || f.relativePath)}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            ) : (
                                <p className="text-xs text-muted-foreground/50 py-4 text-center">
                                    No file changes to revert. Only conversation history will be rolled back.
                                </p>
                            )}

                            <div className="mt-3 p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/15">
                                <p className="text-[10px] text-amber-400/80 leading-relaxed">
                                    ⚠️ This will remove all steps after #{stepIndex + 1} and undo code changes. This action cannot be reversed.
                                </p>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                {!loading && !success && (
                    <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/30 bg-muted/5">
                        <Button variant="ghost" size="sm" onClick={onClose} disabled={reverting} className="text-xs">
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleRevert}
                            disabled={reverting || !!error}
                            className="text-xs bg-amber-600 hover:bg-amber-700 text-white"
                        >
                            {reverting ? (
                                <><Loader2 className="h-3 w-3 animate-spin mr-1" />Reverting…</>
                            ) : (
                                <><RotateCcw className="h-3 w-3 mr-1" />Revert</>
                            )}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
