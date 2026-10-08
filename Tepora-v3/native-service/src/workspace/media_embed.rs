//! Process-local media view handles. The shared State lock orders admission,
//! lookup and network-mode invalidation; neither route makes network requests.
use super::*;
use crate::network::{Domain, NativeNetwork, NetworkError, Purpose};

impl Workspace {
    pub(super) fn media_embed(
        &self,
        body: &Value,
        network: &NativeNetwork,
    ) -> Result<Value, ApiError> {
        // Preserve the source's ordinary null property-access error as well as
        // its strict string-only ASCII YouTube identifier validation.
        if body.is_null() {
            return Err(ApiError::new(
                500,
                "Cannot read properties of null (reading 'id')",
            ));
        }
        let id = body["id"]
            .as_str()
            .filter(|id| {
                id.len() == 11
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .ok_or_else(|| ApiError::bad_request("Invalid video ID"))?;
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        if !network.policy().permitted(Domain::Cloud, Purpose::Web) {
            return Err(
                NetworkError::blocked("インターネットを使う道具を許可してください。").into(),
            );
        }
        // Reuse the host's OS-random 32-byte ephemeral handle generator. These
        // handles are never persisted and do not replace session authentication.
        let token = crate::http::random_token()?;
        if state.media_frames.len() >= 32 {
            state.media_frames.pop_front();
        }
        state.media_frames.push_back((token.clone(), id.to_owned()));
        Ok(json!({"path":format!("/media-view/{token}")}))
    }

    pub(super) fn media_view(
        &self,
        token: &str,
        network: &NativeNetwork,
    ) -> Result<Reply, ApiError> {
        let state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        // Source checks network mode before reporting a missing/evicted handle.
        if !network.policy().permitted(Domain::Cloud, Purpose::Web) {
            return Err(
                NetworkError::blocked("現在の通信設定では外部メディアを表示しません。").into(),
            );
        }
        let id = state
            .media_frames
            .iter()
            .find(|(key, _)| key == token)
            .map(|(_, id)| id.clone())
            .ok_or_else(|| ApiError::new(404, "Media view expired"))?;
        // Lookup does not consume or reorder the FIFO handle. There is no TTL.
        Ok(Reply::MediaView { id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::{
        Admitted, NetworkFuture, NetworkPolicy, NetworkRequest, RequestCancellation, Resolver,
        Transport, TransportResponse,
    };

    struct NoIo;
    impl Resolver for NoIo {
        fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
            panic!("media embed/view must not resolve DNS")
        }
    }
    impl Transport for NoIo {
        fn request<'a>(
            &'a self,
            _: Admitted,
            _: NetworkRequest,
            _: RequestCancellation,
        ) -> NetworkFuture<'a, TransportResponse> {
            panic!("media embed/view must not make any network request")
        }
    }
    fn network() -> NativeNetwork {
        NativeNetwork::with_components(NetworkPolicy::default(), Arc::new(NoIo), Arc::new(NoIo))
    }
    fn fixture() -> (Arc<Workspace>, PathBuf) {
        let dir = env::temp_dir().join(format!("tepora-media-embed-{}", Uuid::new_v4()));
        (Arc::new(Workspace::open(&dir).unwrap()), dir)
    }
    fn embed(w: &Workspace, n: &NativeNetwork, id: &str) -> String {
        w.media_embed(&json!({"id":id}), n).unwrap()["path"]
            .as_str()
            .unwrap()
            .strip_prefix("/media-view/")
            .unwrap()
            .to_owned()
    }
    fn view(w: &Workspace, n: &NativeNetwork, token: &str) -> String {
        match w.media_view(token, n).unwrap() {
            Reply::MediaView { id } => id,
            _ => panic!("media view response expected"),
        }
    }
    fn cleanup(w: Arc<Workspace>, dir: PathBuf) {
        w.shutdown().unwrap();
        drop(w);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn media_embed_validation_and_network_order_without_io() {
        let (w, dir) = fixture();
        let n = network();
        n.update_policy(NetworkPolicy {
            internet_tools: false,
            ..NetworkPolicy::default()
        });
        for body in [
            json!({}),
            json!({"id":42}),
            json!({"id":"aaaaaaaaaa"}),
            json!({"id":"aaaaaaaaaaaa"}),
            json!({"id":"aaaaaaaaaaa\n"}),
            json!({"id":"あああああああああああ"}),
            json!([]),
            json!(false),
        ] {
            let error = w.media_embed(&body, &n).unwrap_err();
            assert_eq!(
                (error.status, error.blocked, error.message.as_str()),
                (400, false, "Invalid video ID")
            );
        }
        let error = w.media_embed(&Value::Null, &n).unwrap_err();
        assert_eq!(
            (error.status, error.message.as_str()),
            (500, "Cannot read properties of null (reading 'id')")
        );
        let error = w.media_embed(&json!({"id":"Ab0_-Cd1_Ef"}), &n).unwrap_err();
        assert_eq!((error.status, error.blocked), (403, true));
        let error = w.media_view("missing", &n).unwrap_err();
        assert_eq!((error.status, error.blocked), (403, true));
        assert!(w.lock().unwrap().media_frames.is_empty());
        n.update_policy(NetworkPolicy::default());
        for id in ["Ab0_-Cd1_Ef", "___________", "-----------", "00000000000"] {
            assert_eq!(view(&w, &n, &embed(&w, &n, id)), id);
        }
        cleanup(w, dir);
    }

    #[test]
    fn media_embed_fifo_repeated_reads_and_restart_without_persistence() {
        let (w, dir) = fixture();
        let n = network();
        let before = w
            .lock()
            .unwrap()
            .call("event.replay", json!({"since":0}))
            .unwrap();
        let tokens: Vec<_> = (0..32)
            .map(|i| embed(&w, &n, &format!("{i:011}")))
            .collect();
        assert!(tokens.iter().all(|t| t.len() == 64
            && t.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))));
        assert_eq!(
            tokens
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            32
        );
        assert_eq!(view(&w, &n, &tokens[0]), "00000000000");
        assert_eq!(view(&w, &n, &tokens[0]), "00000000000");
        let last = embed(&w, &n, "Ab0_-Cd1_Ef");
        assert_eq!(w.media_view(&tokens[0], &n).unwrap_err().status, 404);
        assert_eq!(view(&w, &n, &tokens[1]), "00000000001");
        assert_eq!(view(&w, &n, &last), "Ab0_-Cd1_Ef");
        assert_eq!(w.lock().unwrap().media_frames.len(), 32);
        assert_eq!(
            w.lock()
                .unwrap()
                .call("event.replay", json!({"since":0}))
                .unwrap(),
            before
        );
        w.shutdown().unwrap();
        assert!(w.lock().unwrap().media_frames.is_empty());
        drop(w);
        let restarted = Arc::new(Workspace::open(&dir).unwrap());
        assert_eq!(restarted.media_view(&last, &n).unwrap_err().status, 404);
        cleanup(restarted, dir);
    }

    #[test]
    fn media_embed_concurrent_admissions_are_bounded_by_the_existing_state_owner() {
        let (w, dir) = fixture();
        let n = network();
        let workers: Vec<_> = (0..8)
            .map(|i| {
                let w = w.clone();
                let n = n.clone();
                std::thread::spawn(move || {
                    (0..10)
                        .map(|j| embed(&w, &n, &format!("{:011}", i * 10 + j)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let all: Vec<_> = workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(all.len(), 80);
        assert_eq!(
            all.iter().collect::<std::collections::HashSet<_>>().len(),
            80
        );
        assert_eq!(w.lock().unwrap().media_frames.len(), 32);
        assert_eq!(
            all.iter()
                .filter(|token| w.media_view(token, &n).is_ok())
                .count(),
            32
        );
        cleanup(w, dir);
    }

    #[test]
    fn media_embed_shutdown_rejects_admission_and_lookup_then_clears_handles() {
        let (w, dir) = fixture();
        let n = network();
        let token = embed(&w, &n, "Ab0_-Cd1_Ef");
        w.begin_shutdown().unwrap();
        assert_eq!(
            w.media_embed(&json!({"id":"Ab0_-Cd1_Ef"}), &n)
                .unwrap_err()
                .status,
            503
        );
        assert_eq!(w.media_view(&token, &n).unwrap_err().status, 503);
        assert_eq!(w.lock().unwrap().media_frames.len(), 1);
        w.shutdown().unwrap();
        assert!(w.lock().unwrap().media_frames.is_empty());
        cleanup(w, dir);
    }

    #[test]
    fn media_embed_domain_dispatch_requires_agent_mode() {
        let (w, dir) = fixture();
        for op in [
            Operation::MediaEmbed {
                body: json!({"id":"Ab0_-Cd1_Ef"}),
            },
            Operation::MediaView {
                token: "missing".into(),
            },
        ] {
            assert_eq!(w.execute(op).unwrap_err().status, 503);
        }
        cleanup(w, dir);
    }
}
