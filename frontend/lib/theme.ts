'use client';
import { useState, useEffect, useCallback } from 'react';

export function useTheme() {
    const [isDark, setIsDark] = useState(true);

    useEffect(() => {
        const saved = localStorage.getItem('antigravity-theme');
        const dark = saved ? saved === 'dark' : true;
        setIsDark(dark);
        document.documentElement.classList.toggle('dark', dark);
    }, []);

    const toggle = useCallback(() => {
        setIsDark(prev => {
            const next = !prev;
            localStorage.setItem('antigravity-theme', next ? 'dark' : 'light');
            document.documentElement.classList.toggle('dark', next);
            return next;
        });
    }, []);

    return { isDark, toggle };
}
