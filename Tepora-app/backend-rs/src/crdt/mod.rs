/// CRDT PoC Module — Day 7: Automerge による同期実験
///
/// セッションタイトルを Automerge ドキュメントとして管理し、
/// 2つの独立したフォークが同時に編集された後、マージでコンフリクトが
/// 自動解決されることを検証する。
///
/// このモジュールは `redesign_crdt` feature flag で有効化される。

#[cfg(test)]
mod tests {
    use automerge::{transaction::Transactable, AutoCommit, ObjType, ReadDoc};

    /// 基本テスト: セッションタイトルを設定して読み戻す
    #[test]
    fn test_crdt_basic_put_get() {
        let mut doc = AutoCommit::new();
        let root = automerge::ROOT;

        // セッションタイトルを設定
        doc.put(&root, "session_title", "My Chat Session")
            .expect("Failed to put session_title");

        // 読み戻し
        let title: String = doc
            .get(&root, "session_title")
            .expect("Failed to get session_title")
            .unwrap()
            .0
            .into_string()
            .expect("Not a string");
        assert_eq!(title, "My Chat Session");
    }

    /// コアテスト: 2つの独立フォークが同時編集→マージで自動解決
    #[test]
    fn test_crdt_concurrent_edit_merge() {
        // 初期ドキュメント
        let mut doc_origin = AutoCommit::new();
        let root = automerge::ROOT;
        doc_origin
            .put(&root, "session_title", "Original Title")
            .expect("Failed to put");

        // フォーク: 2つの独立コピーを作成
        let mut doc_a = doc_origin.fork();
        let mut doc_b = doc_origin.fork();

        // Doc A がタイトルを変更
        doc_a
            .put(&root, "session_title", "Title from Device A")
            .expect("Failed to put on A");

        // Doc B が同じフィールドを別の値に変更
        doc_b
            .put(&root, "session_title", "Title from Device B")
            .expect("Failed to put on B");

        // マージ: A が B の変更を取り込む
        doc_a
            .merge(&mut doc_b)
            .expect("Failed to merge B into A");

        // 結果を読み出す - 勝者はどちらかが決まるが、コンフリクトは自動解決される
        let merged_title: String = doc_a
            .get(&root, "session_title")
            .expect("Failed to get")
            .unwrap()
            .0
            .into_string()
            .expect("Not a string");

        // Automerge は LWW (Last Writer Wins) ベースでコンフリクト解決する
        // どちらかのタイトルが残ることを確認（パニックしない = 自動解決成功）
        assert!(
            merged_title == "Title from Device A" || merged_title == "Title from Device B",
            "Unexpected merged title: {}",
            merged_title
        );

        // 逆方向のマージも確認（対称性）
        doc_b
            .merge(&mut doc_a)
            .expect("Failed to merge A into B");

        let merged_title_b: String = doc_b
            .get(&root, "session_title")
            .expect("Failed to get")
            .unwrap()
            .0
            .into_string()
            .expect("Not a string");

        // 両方のドキュメントが同じ結果に収束すること
        assert_eq!(merged_title, merged_title_b, "Documents did not converge after bidirectional merge");
    }

    /// テスト: 複数フィールドの同時編集（コンフリクトなしの並行編集）
    #[test]
    fn test_crdt_non_conflicting_concurrent_edits() {
        let mut doc_origin = AutoCommit::new();
        let root = automerge::ROOT;
        doc_origin
            .put(&root, "session_title", "Shared Session")
            .expect("Failed to put title");
        doc_origin
            .put(&root, "message_count", 0i64)
            .expect("Failed to put count");

        let mut doc_a = doc_origin.fork();
        let mut doc_b = doc_origin.fork();

        // Doc A がタイトルを変更
        doc_a
            .put(&root, "session_title", "Renamed Session")
            .expect("Failed to put on A");

        // Doc B がメッセージ数を更新（異なるフィールド = コンフリクトなし）
        doc_b
            .put(&root, "message_count", 5i64)
            .expect("Failed to put on B");

        // マージ
        doc_a
            .merge(&mut doc_b)
            .expect("Failed to merge");

        let title: String = doc_a
            .get(&root, "session_title")
            .expect("Failed to get")
            .unwrap()
            .0
            .into_string()
            .expect("Not a string");
        let count = doc_a
            .get(&root, "message_count")
            .expect("Failed to get")
            .unwrap()
            .0
            .to_i64();

        // 両方の変更が保持されていること
        assert_eq!(title, "Renamed Session");
        assert_eq!(count, Some(5));
    }

    /// テスト: ドキュメントのシリアライズ/デシリアライズ（永続化 PoC）
    #[test]
    fn test_crdt_save_load() {
        let mut doc = AutoCommit::new();
        let root = automerge::ROOT;
        doc.put(&root, "session_title", "Persistent Session")
            .expect("Failed to put");

        // バイト列にシリアライズ
        let bytes = doc.save();
        assert!(!bytes.is_empty(), "Serialized document should not be empty");

        // デシリアライズ
        let loaded_doc = AutoCommit::load(&bytes).expect("Failed to load document");
        let title: String = loaded_doc
            .get(&root, "session_title")
            .expect("Failed to get")
            .unwrap()
            .0
            .into_string()
            .expect("Not a string");
        assert_eq!(title, "Persistent Session");
    }

    /// テスト: リスト（配列）型のCRDT操作
    #[test]
    fn test_crdt_list_operations() {
        let mut doc = AutoCommit::new();
        let root = automerge::ROOT;

        // タグリストを作成
        let tags = doc
            .put_object(&root, "tags", ObjType::List)
            .expect("Failed to create list");
        doc.insert(&tags, 0, "important")
            .expect("Failed to insert");
        doc.insert(&tags, 1, "work")
            .expect("Failed to insert");

        // フォークして並行追加
        let mut doc_a = doc.fork();
        let mut doc_b = doc.fork();

        doc_a
            .insert(&tags, 2, "urgent")
            .expect("Failed to insert on A");
        doc_b
            .insert(&tags, 2, "personal")
            .expect("Failed to insert on B");

        doc_a.merge(&mut doc_b).expect("Failed to merge");

        let length = doc_a.length(&tags);
        assert_eq!(length, 4, "Merged list should have 4 items (2 original + 2 concurrent inserts)");
    }
}
