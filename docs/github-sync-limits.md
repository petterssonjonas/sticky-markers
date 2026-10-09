# GitHub vault sync safety limits

Sticky Markers only synchronizes private GitHub vaults created or reconnected through the app. Other configured folders remain externally managed.

Version 0.7 indexes local content hashes and remote Git blob identifiers instead of holding copies of every file in memory. Changed remote files are decoded one at a time into temporary files outside the vault, then applied after validation and conflict checks. Temporary staging is removed on success or error. A saved blob identifier lets subsequent unchanged syncs avoid downloading that file again; older vault configurations perform one initial download to populate this cache.

The limits are:

| Resource | Limit |
| --- | --- |
| Editable UTF-8 text file | 100 KiB |
| Attachment | 20 MiB |
| Supported files per local, remote, or merged vault | 10,000 |
| Total candidate file size per local, remote, or merged vault | 256 MiB |
| Individual API metadata response | 4 MiB |
| Individual base64 blob response | 29 MiB |
| Concurrent payload sync/conflict operations across app-managed vaults using the same app data directory | 1 |

Response bounds apply even when the server does not provide a content length. Decoded blobs must match their declared size. Local attachment hashing uses a 64 KiB buffer; file contents are otherwise loaded only for a single upload, recovery copy, or application. Base64 and JSON processing still need bounded per-file temporary memory. Sync is run on background workers.

Aggregate limits are checked before local file changes, conflict recovery, or a remote commit. A limit failure preserves both vaults and the previous sync baseline; the app reports which limit to address before retrying. Metadata requests and temporary staging may already have occurred. The GitHub error field is updated to explain the failure.

The existing three-way comparison, recovery copies, fresh checks before replacing local files, and non-force GitHub branch updates remain in place. Concurrent edits or a remote branch advance can require a retry; sync does not silently choose a conflicting version.
