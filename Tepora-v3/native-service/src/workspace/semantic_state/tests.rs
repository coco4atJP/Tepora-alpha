use super::*;
struct Fixture {
    workspace: Workspace,
    root: PathBuf,
    profile: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = env::temp_dir().join(format!("tepora-semantic-cas-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&root).unwrap();
        let profile =
            json!({"identity":"fixture-space","enabled":true,"role":"embedding","domain":"device"});
        workspace.lock().unwrap().set_value("capabilities",json!({"schema":1,"revision":1,"profiles":[profile.clone()],"routes":{"embedding":"fixture"}})).unwrap();
        Self {
            workspace,
            root,
            profile,
        }
    }
    fn proposal(&self, id: &str) -> VectorProposal {
        let before = json!({"id":id,"confirmed":true,"content":"unchanged","scope":"private"});
        self.workspace
            .lock()
            .unwrap()
            .put("memory", before.clone())
            .unwrap();
        VectorProposal {
            before,
            vector: json!({"id":id,"identity":"fixture-space","contentHash":crate::semantic::content_hash("unchanged"),"dimensions":2,"vector":[1,0]}),
        }
    }
    fn vector(&self, id: &str) -> Value {
        self.workspace
            .lock()
            .unwrap()
            .get("memory-vector", id)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.workspace.shutdown().unwrap();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn vector_batch_rechecks_identity_and_each_document_under_the_same_owner() {
    let f = Fixture::new();
    let a = f.proposal("a");
    let b = f.proposal("b");
    let mut changed = b.before.clone();
    changed["scope"] = json!("shared");
    f.workspace.lock().unwrap().put("memory", changed).unwrap();
    assert_eq!(
        f.workspace
            .access()
            .commit_vectors(&f.profile, &[a.clone(), b])
            .unwrap(),
        1
    );
    assert!(!f.vector("a").is_null());
    assert!(f.vector("b").is_null());
    f.workspace
        .lock()
        .unwrap()
        .set_value("capabilities", json!({"profiles":[],"routes":{}}))
        .unwrap();
    assert_eq!(
        f.workspace
            .access()
            .commit_vectors(&f.profile, &[a])
            .unwrap_err()
            .status,
        409
    );
}
#[test]
fn partial_sql_failure_rolls_back_all_vector_publication() {
    let f = Fixture::new();
    let a = f.proposal("a");
    let b = f.proposal("b");
    f.workspace.lock().unwrap().call("exec",json!({"sql":"CREATE TEMP TRIGGER reject_second_vector BEFORE INSERT ON documents WHEN NEW.kind='memory-vector' AND NEW.id='b' BEGIN SELECT RAISE(ABORT,'fixture vector failure'); END"})).unwrap();
    assert!(f
        .workspace
        .access()
        .commit_vectors(&f.profile, &[a.clone(), b.clone()])
        .is_err());
    assert!(f.vector("a").is_null());
    assert!(f.vector("b").is_null());
    f.workspace
        .lock()
        .unwrap()
        .call("exec", json!({"sql":"DROP TRIGGER reject_second_vector"}))
        .unwrap();
    assert_eq!(
        f.workspace
            .access()
            .commit_vectors(&f.profile, &[a, b])
            .unwrap(),
        2
    );
}
