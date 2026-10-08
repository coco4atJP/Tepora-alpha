//! Semantic cache adapter on Workspace's sole SQLite owner. This is not a
//! second store, and vector writes do not modify session transcripts.
use super::*;
use crate::semantic::{same_document, MemorySnapshot, SemanticState, VectorProposal};
impl SemanticState for WorkspaceAccess {
    fn snapshot(&self) -> Result<MemorySnapshot, ApiError> {
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let documents = state.list("memory")?;
        let mut vectors = std::collections::HashMap::new();
        for document in &documents {
            let id = document["id"]
                .as_str()
                .ok_or_else(|| ApiError::new(500, "Invalid memory identity"))?;
            let vector = state.get("memory-vector", id)?;
            if !vector.is_null() {
                vectors.insert(id.to_owned(), vector);
            }
        }
        Ok(MemorySnapshot { documents, vectors })
    }
    fn current(&self, ids: &[String]) -> Result<Vec<Value>, ApiError> {
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let mut documents = Vec::with_capacity(ids.len());
        for id in ids {
            let document = state.get("memory", id)?;
            if !document.is_null() {
                documents.push(document);
            }
        }
        Ok(documents)
    }
    fn commit_vectors(
        &self,
        profile: &Value,
        proposals: &[VectorProposal],
    ) -> Result<usize, ApiError> {
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let registry = state.value("capabilities")?;
        let current = registry["profiles"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| {
                truth(&p["enabled"])
                    && p["identity"] == profile["identity"]
                    && p["role"] == "embedding"
            });
        require(
            current.is_some(),
            409,
            "Embedding endpoint changed before cache publication",
        )?;
        let external = current.unwrap()["domain"] != "device";
        state.call("exec", json!({"sql":"SAVEPOINT native_semantic_vectors"}))?;
        let result: Result<usize, ApiError> = (|| {
            let mut added = 0;
            for proposal in proposals {
                let id = proposal.before["id"]
                    .as_str()
                    .ok_or_else(|| ApiError::new(500, "Invalid memory identity"))?;
                let now = state.get("memory", id)?;
                if !same_document(&proposal.before, &now) || external && now["scope"] != "shared" {
                    continue;
                }
                state.put("memory-vector", proposal.vector.clone())?;
                added += 1;
            }
            Ok(added)
        })();
        match result {
            Ok(added) => {
                if let Err(error) =
                    state.call("exec", json!({"sql":"RELEASE native_semantic_vectors"}))
                {
                    let _=state.call("exec",json!({"sql":"ROLLBACK TO native_semantic_vectors; RELEASE native_semantic_vectors"}));
                    return Err(error);
                }
                Ok(added)
            }
            Err(error) => {
                let _=state.call("exec",json!({"sql":"ROLLBACK TO native_semantic_vectors; RELEASE native_semantic_vectors"}));
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests;
