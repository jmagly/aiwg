The bug: the cache was shared between workers. Workers wrote into it without locks.

Why it matters: the worker now reads the record before publishing.

The takeaway: the switch now stops the publisher.
