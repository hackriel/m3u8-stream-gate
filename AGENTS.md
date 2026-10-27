# Architecture rules
- The laboratory lives in a separate VPS module mounted by the existing emitter; it snapshots local completed HLS segments and never scrapes, changes output profiles, or registers children as emission processes, to keep experiments separate from production.
- Laboratory comparisons use a single sequential low-priority job, bounded local files and execution time, and only dashboard-authorized requests; delete scratch media immediately and retain downloadable outputs under separate time and total-size caps to bound resource use.
- Laboratory measurements describe re-encoding of the current delivered output, not pristine upstream quality or end-client buffering; never present processing metrics as proof of perceptual improvement.
- Keep the laboratory candidate catalog separate from production profiles and return its metadata from the API; each run snapshots the catalog and processes every candidate sequentially against the same sample, so experiments cannot change live profile selections.
- Bulk emission telemetry derives its process range from the HLS channel map so newly added channel tabs receive live statistics without another hardcoded range update.
