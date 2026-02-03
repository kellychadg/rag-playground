# RAG Playground

A minimal Node + Postgres + pgvector RAG playground with a simple browser UI.

## Setup (Docker for Postgres + pgvector)

1. Start Postgres + pgvector.

```bash
docker compose up -d
```

2. Install dependencies.

```bash
npm install
```

3. Create the schema.

```bash
psql postgresql://postgres:password@localhost:5432/rag_playground -f db/schema.sql
```

If `psql` is not installed locally, you can run it inside the container:

```bash
docker exec -i rag-playground-db psql -U postgres -d rag_playground -f /dev/stdin < db/schema.sql
```

4. Create a `.env` file based on `.env.example` and set `OPENAI_API_KEY`.

5. Start the server.

```bash
npm run dev
```

6. Open `http://localhost:3000`.

## Local Embeddings (No OpenAI Quota)

Set these in `.env` to use a local embedding model:

```
LOCAL_EMBEDDINGS=true
LOCAL_EMBED_MODEL=Xenova/paraphrase-MiniLM-L3-v2
EMBED_DIM=384
```

If you are switching from OpenAI embeddings (1536 dims) to local (384 dims), drop and recreate the table:

```bash
psql postgresql://postgres:password@localhost:5432/rag_playground -c "DROP TABLE IF EXISTS rag_chunks;"
psql postgresql://postgres:password@localhost:5432/rag_playground -f db/schema.sql
```

The first local embedding call downloads the model and may take a minute. Use the **Warm Model** button in the UI to pre-download it.

## PDF OCR (MinerU)

This project can ingest PDFs via MinerU. MinerU supports Python 3.10-3.13, and on Windows it supports 3.10-3.12.

1. Create and activate a virtual environment.

```bash
python -m venv .venv
. .venv\Scripts\Activate.ps1
python -m pip install -U pip
```

2. Install MinerU.

```bash
pip install "mineru[core]"
```

3. Point the server to the MinerU CLI if it is not on PATH:

```bash
MINERU_CMD=.venv\Scripts\mineru.exe
```

## API Notes

This project uses the OpenAI Embeddings endpoint at `https://api.openai.com/v1/embeddings` and the Chat Completions endpoint at `https://api.openai.com/v1/chat/completions`, with Bearer token authentication in the `Authorization` header. See the OpenAI API reference for details.

## UI Notes

- Upload `.txt` or `.pdf` files.
- Use **Warm Model** to pre-download the local embedding model.
- The **Extracted Text (Preview)** panel shows what was ingested.
