// Desktop notification helpers

export function requestNotificationPermission() {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

export function showNotification(title: string, body: string) {
    if (typeof window === 'undefined') return;
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification(title, {
            body: body.slice(0, 100),
            icon: '/favicon.ico',
        });
    }
}
