# Architecture rules
- The laboratory lives in a separate VPS module mounted by the existing emitter; it snapshots local completed HLS segments and never scrapes, changes output profiles, or registers children as emission processes, to keep experiments separate from production.
- Laboratory comparisons use a single sequential low-priority job, bounded local files and execution time, and only dashboard-authorized requests; retain reports but remove media to bound resource use.
- Laboratory measurements describe re-encoding of the current delivered output, not pristine upstream quality or end-client buffering; never present processing metrics as proof of perceptual improvement.
