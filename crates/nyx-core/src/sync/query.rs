//! RAG query over the team's documents. Port of `query.service.ts`: retrieve the top chunks for a
//! question, hand them to the model as the only allowed context and stream the answer.

use rusqlite::Connection;

use super::retrieval::{retrieve_chunks, Embedder, RetrieveOptions, RetrievedChunk};
use crate::ai::{LlmProvider, LlmRequest, ModelPair};
use crate::error::Result;

/// Chunks retrieved per question (TS: `topK: 8`).
pub const QUERY_TOP_K: usize = 8;
/// Reply when nothing relevant was retrieved (no model call is made).
pub const NO_DOCS_MESSAGE: &str = "No relevant documentation found for your query.";

const SYSTEM: &str = "You are a documentation assistant for the Nyx platform. Answer the user's question based ONLY on the provided documentation context. If the context doesn't contain enough information to answer, say so clearly. Be concise and cite relevant document sections when possible.";

/// The answer plus the evidence it was built from.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryAnswer {
    /// Full answer text.
    pub text: String,
    /// Chunks given to the model (empty when nothing was found).
    pub sources: Vec<RetrievedChunk>,
}

/// Build the context block: `[Chunk i | doc:<id> | score:0.87]` headers separated by `---`.
#[must_use]
pub fn build_context(chunks: &[RetrievedChunk]) -> String {
    chunks
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "[Chunk {} | doc:{} | score:{:.2}]\n{}",
                i + 1,
                c.doc_id,
                c.score,
                c.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

/// Answer `query` from the team's documents, calling `on_chunk` with text fragments as they
/// arrive. `opts.top_k` is overridden by [`QUERY_TOP_K`] only when left at the default of 5.
///
/// # Errors
/// Embedding, database or provider failure (a missing key surfaces as `Error::NotFound`).
pub fn query_docs(
    conn: &Connection,
    embedder: &dyn Embedder,
    llm: &dyn LlmProvider,
    models: &ModelPair,
    query: &str,
    team_id: &str,
    opts: Option<RetrieveOptions>,
    on_chunk: &mut dyn FnMut(&str),
) -> Result<QueryAnswer> {
    let opts = opts.unwrap_or(RetrieveOptions {
        top_k: QUERY_TOP_K,
        ..RetrieveOptions::default()
    });
    let sources = retrieve_chunks(conn, embedder, query, team_id, &opts)?;
    if sources.is_empty() {
        on_chunk(NO_DOCS_MESSAGE);
        return Ok(QueryAnswer {
            text: NO_DOCS_MESSAGE.to_owned(),
            sources,
        });
    }
    let user = format!(
        "Context from documentation:\n\n{}\n\n---\n\nQuestion: {query}",
        build_context(&sources)
    );
    let req = LlmRequest::simple(&models.default, SYSTEM, user, 2048);
    let resp = llm.complete_stream(&req, on_chunk)?;
    Ok(QueryAnswer {
        text: resp.text,
        sources,
    })
}

#[cfg(test)]
#[allow(clippy::cast_possible_wrap, clippy::default_trait_access)]
mod tests {
    use super::*;
    use crate::ai::FakeLlm;
    use crate::model::{NewDocument, NewTeam, NewUser, UserRole};
    use crate::store::{
        Db, DocumentRepo, SqliteDocuments, SqliteTeams, SqliteUsers, TeamRepo, UserRepo,
    };
    use crate::sync::retrieval::{index_document, HashingEmbedder};

    fn models() -> ModelPair {
        ModelPair {
            default: "m".into(),
            fast: "f".into(),
        }
    }

    #[test]
    fn context_format_matches_ts() {
        let c = [
            RetrievedChunk {
                content: "A".into(),
                doc_id: "d1".into(),
                score: 0.876,
                chunk_index: 0,
            },
            RetrievedChunk {
                content: "B".into(),
                doc_id: "d2".into(),
                score: 0.5,
                chunk_index: 1,
            },
        ];
        assert_eq!(
            build_context(&c),
            "[Chunk 1 | doc:d1 | score:0.88]\nA\n\n---\n\n[Chunk 2 | doc:d2 | score:0.50]\nB"
        );
    }

    #[test]
    fn answers_from_retrieved_chunks_and_short_circuits_when_empty() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let u = SqliteUsers::new(c)
            .create(&NewUser {
                email: "a@x.io".into(),
                name: "A".into(),
                avatar_url: None,
            })
            .unwrap();
        let teams = SqliteTeams::new(c);
        let t = teams
            .create(&NewTeam {
                name: "T".into(),
                slug: "t".into(),
            })
            .unwrap();
        teams.add_member(&t.id, &u.id, UserRole::Owner).unwrap();
        let d = SqliteDocuments::new(c)
            .create(&NewDocument {
                title: "Webhooks".into(),
                content: "Webhook payloads are verified with an HMAC signature header".into(),
                path: String::new(),
                team_id: t.id.clone(),
                created_by_id: u.id,
                stage: None,
                lifecycle_id: None,
            })
            .unwrap();
        let emb = HashingEmbedder::new(128);
        index_document(c, &emb, &d, 1, &Default::default()).unwrap();

        let llm = FakeLlm::with_texts(&["Verified with HMAC."]);
        let mut streamed = String::new();
        let a = query_docs(
            c,
            &emb,
            &llm,
            &models(),
            "how are webhook payloads verified with HMAC",
            &t.id,
            None,
            &mut |s| streamed.push_str(s),
        )
        .unwrap();
        assert_eq!(a.text, "Verified with HMAC.");
        assert_eq!(streamed, a.text);
        assert_eq!(a.sources[0].doc_id, d.id);
        let sent = &llm.requests()[0];
        assert!(sent.messages[0]
            .content
            .contains("Question: how are webhook payloads"));
        assert!(sent.messages[0].content.contains(&format!("doc:{}", d.id)));
        assert!(sent
            .system
            .contains("based ONLY on the provided documentation"));

        let silent = FakeLlm::new();
        let none = query_docs(
            c,
            &emb,
            &silent,
            &models(),
            "zzz qqq",
            "other-team",
            None,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(none.text, NO_DOCS_MESSAGE);
        assert_eq!(silent.call_count(), 0);
    }
}
