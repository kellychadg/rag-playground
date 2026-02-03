# Next Session Plan

## Current Status
- Repo: `C:\Repos\rag-playground`
- Node + Express UI is scaffolded with pgvector + Docker
- MinerU is installed in `.venv` and wired for PDF OCR
- Local embeddings enabled via `@xenova/transformers`
- Warm-up endpoint and UI button exist

## Pick Up Checklist
1. Start Docker and the database
- `docker compose up -d`
2. Start the server
- `npm run dev`
3. In the UI, click **Warm Model** and wait for confirmation
4. Upload a PDF and verify:
- Extracted text preview populates
- Ingest succeeds and query returns results

## Troubleshooting
- If Warm Model returns HTML instead of JSON, restart the server
- If embeddings are still slow, consider:
- A lighter model
- Increasing warm-up timeout
- If schema errors appear, reapply:
- `docker exec -i rag-playground-db psql -U postgres -d rag_playground -f /dev/stdin < db/schema.sql`

## Next Enhancements
- Add progress indicator for OCR + embedding stages
- Add top-K slider for retrieval
- Add local chat model option
