// Treat freshly copied prompt files as settled without waiting on wall time.
const now = Date.now;
Date.now = () => now() + 60_000;
