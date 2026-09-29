# ADR-0078: Document uploads and storage (DOC-1)

- Status: Proposed (Geovet's continuous execution mode, 2026-09-29; Document Engine block DOC-1)
- Date: 2026-09-29
- Builds on:
  - [ADR-0019](0019-rbac-foundation.md) and [ADR-0020](0020-audit-log-foundation.md) (permissions, audit);
  - [ADR-0038](0038-vertex-ai-activation.md) (calling a Google API with the service's own identity);
  - [ADR-0051](0051-company-brain.md) (Company Brain and its text documents);
  - [ADR-0061](0061-commercial-list-pagination.md) (paginated lists and their missing-index fallback).
- Does not change: Company Brain, the AI Gateway, GIA, agents or the web app.
- Terraform: a private bucket, two bucket grants, one Firestore index and one api setting, behind `document_storage` (DEV only). Not applied.

## Context

Company Brain takes documents only as pasted text (`POST /brain/documents`, at most 60,000 characters). People keep what their business knows in files: price lists, contracts, proposals. The Document Engine starts by keeping those files safely, per organization, and by giving plain text files to Company Brain. Reading PDF and Word files is a separate decision.

## Decision

### 1. What is accepted

- A closed list of types: `text/plain`, `text/markdown`, `text/csv`, `application/pdf` and DOCX (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`). Anything else is `415 unsupported_type`. A text type may say `charset=utf-8`; no other parameter.
- The declared type is never trusted alone. The bytes must match it, or the upload is `400 invalid_document` (`field: content`):
  - a PDF starts with `%PDF-`;
  - a DOCX starts with a zip header (`PK\x03\x04`);
  - a text file is valid UTF-8 (strict decoding) with no NUL byte.
- At most 10 MB. An empty file is refused.
- The name: trimmed, 1 to 200 characters, no control characters, no `/` or `\`, no bidirectional overrides. It is only a label: it never becomes part of a storage key.

### 2. Storage

- Bytes in Cloud Storage, one private bucket per environment (`{project}-documents`).
- The object key is built by the server only: `organizations/{organizationId}/documents/{documentId}`. Both are UUIDs; nothing from the client is in it.
- The document id is a name-based UUID of the organization and the content's SHA-256. The same bytes uploaded again in the same organization return the stored document (`200`, `duplicate: true`) and store nothing new. The same bytes in another organization are another document under another key.
- The api talks to the Cloud Storage JSON API with its own identity (a metadata-server token, as for Vertex AI). No SDK, no key.
  - Upload: `POST …/upload/storage/v1/b/{bucket}/o?uploadType=media&name={key}&ifGenerationMatch=0`. An object is created once and never replaced; `412` (it exists) is success, since the key is the content's digest.
  - Download: `GET …/storage/v1/b/{bucket}/o/{key}?alt=media`; `404` is "no object".
  - Any other failure is `503 storage_unavailable`, without Google's message.
- Without `DOCUMENTS_BUCKET`, uploads and downloads answer `503 storage_unavailable` (fails closed). Records can still be listed.
- Records in Firestore, `documents/{documentId}`: organization, name, type, size, SHA-256, storage key, status, who uploaded and when. Written once with its audit event in one transaction; only the status changes afterwards.
- A download is served only when the bytes read back have the stored size and SHA-256. Otherwise `503 storage_unavailable`, logged as `documents.content_mismatch`.

### 3. Order of an upload

1. Tenant, `document.upload`, a person acting directly.
2. The bucket is configured.
3. Name, type and bytes are checked.
4. The SHA-256 and id are computed. A stored document is returned as a duplicate.
5. The bytes are stored.
6. The record and its `document.uploaded` audit event are written together, or neither.
7. A text file's text goes to Company Brain (below).

A record never points at bytes that were not stored. A failure between 5 and 6 can leave an object with no record; uploading again completes it.

### 4. Company Brain

- Only text files, through `ingestDocument(tenant, {name, text})`, as the person, only when they have `knowledge.propose`. Company Brain applies its own rules, extraction and audit.
- The document's status says what happened:
  - `stored`: kept, text not read (PDF and DOCX, always, for now);
  - `ingested`: Company Brain holds the text (`knowledgeDocumentId` names its document);
  - `not_ingested`, with a code in `ingestion`: `too_long` (over 60,000 characters), `no_text`, `not_permitted`, `refused` (Company Brain refused it) or `unavailable` (not configured, or it failed).
- A failed ingestion never fails the upload. It is logged as `documents.ingestion_failed` with a code only.

### 5. Who may do what

| Route                                                      | Permission        |
| ---------------------------------------------------------- | ----------------- |
| `POST /v1/organizations/:org/documents?name=…` (raw body)  | `document.upload` |
| `GET /v1/organizations/:org/documents?limit=&cursor=`      | `document.read`   |
| `GET /v1/organizations/:org/documents/:documentId`         | `document.read`   |
| `GET /v1/organizations/:org/documents/:documentId/content` | `document.read`   |

- Both permissions are new, owner only.
- Uploading is a person's act: GIA and the runtime are refused (`403 permission_denied`).
- `POST` answers `201` for a new document and `200` for a duplicate, with `{document, duplicate}`. A declared `content-length` over 10 MB is refused (`413 document_too_large`) before the body is read; the size is checked again on what was read.
- The list is newest first, 20 per page by default, at most 50, with a cursor bound to the organization.
- The view never includes the storage key.
- A download has the stored type, `content-disposition: attachment` with an ASCII fallback name and the exact name in RFC 8187 form (every unsafe character replaced or percent-encoded), `x-content-type-options: nosniff`, `cache-control: private, no-store` and a `sandbox` content security policy.

## Security and tenancy

- Every read checks the organization. Another organization's document is `404 document_not_found`, exactly like a missing one.
- The key comes from two UUIDs the server holds. A name with `../`, a slash or a control character is refused, and would never reach a key anyway.
- The api's identity gets `roles/storage.objectCreator` and `roles/storage.objectViewer` on the documents bucket only. It cannot overwrite or delete an object (that needs `storage.objects.delete`). Nothing else gets object access through Terraform.
- The bucket has uniform bucket-level access, public access prevention `enforced` and no versioning (objects are never replaced). `force_destroy` is always false: a destroy fails while documents exist.
- Audit: `document.uploaded` (category `document`, target `{type: 'document', id}`). Never the name or the content. A duplicate records nothing.
- Logs carry codes and document ids only.

## Consequences

- People can keep their files in MelonOffice, per organization, and text files feed Company Brain with the same rules as pasted text.
- The api holds up to 10 MB of one upload in memory. At 80 concurrent requests on 512 MiB that is more than the instance has, so heavy concurrent uploads can run it out of memory. Streaming uploads straight to Cloud Storage, or a lower concurrency, is follow-up work if it shows.
- Terraform: `document_storage` (default false; on in DEV) creates the bucket, its two grants, enables `storage.googleapis.com` and sets `DOCUMENTS_BUCKET` on the api. It requires the apps and Firestore (the runtime's condition), since the api holds the grants and Firestore the records.
- A Firestore index `documents (organizationId, createdAt desc)` is added with Firestore. Until it exists, the list reads at most 500 documents without it and logs `firestore.index_missing`.
- The planner needs nothing new: `storage.buckets.get` and `storage.buckets.getIamPolicy` are already in its base role, and it never reads objects.

## Open

1. **Reading PDF and DOCX text.** Pending Geovet's decision: a local library, Gemini through the AI Gateway (costs credits, sends the file to a model), or both. Until then those files stay `stored`.
2. **Web UI** for uploading, listing and downloading documents.
3. **Deletion and retention.** Nothing deletes a document or its object today, and the api cannot.
4. **Virus and malware scanning** before a file is served back.
5. **DEV apply** of the bucket, grants, index and setting. Only Geovet authorizes it.
6. **What to validate in DEV** after the apply:
   - upload a `.txt` and see it `ingested` in Company Brain;
   - upload a PDF and a DOCX and see them `stored`;
   - download each and compare the bytes;
   - upload the same file again and get `duplicate: true`;
   - confirm a second organization cannot read the first one's documents;
   - confirm the bucket is not public and the api cannot delete an object.
