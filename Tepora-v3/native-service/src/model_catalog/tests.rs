use super::*;
use crate::network::{
    Admitted, ByteStream, NetworkFuture, NetworkPolicy, Resolver, Transport, TransportResponse,
};
use std::{collections::HashMap, sync::Mutex};
#[derive(Default)]
struct State(Mutex<HashMap<String, Value>>);
impl ProviderState for State {
    fn value(&self, _: &str) -> Result<Option<Value>, ApiError> {
        panic!("catalog does not access settings or keys")
    }
    fn set_value(&self, _: &str, _: Value) -> Result<(), ApiError> {
        panic!("catalog does not change settings or keys")
    }
    fn get(&self, c: &str, id: &str) -> Result<Option<Value>, ApiError> {
        assert_eq!((c, id), ("catalog", "models.dev"));
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn put(&self, c: &str, v: Value) -> Result<(), ApiError> {
        assert_eq!(c, "catalog");
        self.0.lock().unwrap().insert("models.dev".into(), v);
        Ok(())
    }
    fn emit(&self, _: &str, _: Value) -> Result<(), ApiError> {
        panic!("catalog import emits no event")
    }
}
#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<String>>,
    body: Mutex<Vec<u8>>,
    pending: bool,
}
impl Resolver for Fake {
    fn lookup<'a>(&'a self, host: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move {
            assert_eq!(host, "models.dev");
            Ok(vec!["93.184.216.34".into()])
        })
    }
}
impl Transport for Fake {
    fn request<'a>(
        &'a self,
        a: Admitted,
        r: NetworkRequest,
        c: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            assert_eq!(a.url.as_str(), CATALOG_URL);
            assert!(r.body.is_empty());
            assert!(!r.headers.contains_key("authorization"));
            self.calls.lock().unwrap().push(a.url.to_string());
            if self.pending {
                return Err(c.cancelled().await);
            }
            let bytes = self.body.lock().unwrap().clone();
            let body: ByteStream = Box::pin(futures_util::stream::iter(vec![Ok(bytes.into())]));
            Ok(TransportResponse {
                status: 200,
                headers: hyper::HeaderMap::new(),
                body: Some(body),
            })
        })
    }
}
fn fixture(pending: bool) -> (ModelCatalog, Arc<State>, Arc<Fake>, NativeNetwork) {
    let state = Arc::new(State::default());
    let fake = Arc::new(Fake {
        body: Mutex::new(
            br#"{"p":{"models":{"m":{"name":"Vision","modalities":{"input":["text","image"]}}}}}"#
                .to_vec(),
        ),
        pending,
        ..Default::default()
    });
    let network =
        NativeNetwork::with_components(NetworkPolicy::default(), fake.clone(), fake.clone());
    (
        ModelCatalog::new(state.clone(), network.clone()),
        state,
        fake,
        network,
    )
}
#[test]
fn source_fixtures_preserve_json_validation_order_costs_modalities_utf16_and_numeric_keys() {
    let cases = json_codec::parse(include_str!("fixtures.json")).unwrap();
    for case in cases.as_array().unwrap() {
        match parse_catalog(&case["raw"]) {
            Ok(value) => assert_eq!(
                json_codec::stringify_js(&json!(value)).unwrap(),
                json_codec::stringify_js(&case["result"]).unwrap(),
                "{}",
                case["name"]
            ),
            Err(error) => {
                assert_eq!(
                    error.status,
                    case["error"]["status"].as_u64().unwrap() as u16,
                    "{}",
                    case["name"]
                );
                assert_eq!(error.message, case["error"]["message"].as_str().unwrap());
            }
        }
    }
}
#[test]
fn import_search_is_bounded_data_only_and_exact_wire_hash() {
    let (catalog, state, fake, _) = fixture(false);
    assert_eq!(
        catalog.search("").unwrap(),
        json!({"models":[],"count":0,"at":null,"verified":false})
    );
    let raw=json_codec::parse(r#"{"p":{"npm":"run","api":"file:///secret","models":{"m":{"name":"Vision\ud800","tool_call":true,"modalities":{"input":["image"]},"limit":{"context":1000}}}}}"#).unwrap();
    let result = catalog.import(&raw).unwrap();
    assert_eq!(result["count"], 1);
    assert_eq!(
        catalog.search("VISION\u{feff}image").unwrap()["models"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let saved = state.0.lock().unwrap()["models.dev"].clone();
    assert_eq!(
        saved["sha256"],
        format!(
            "{:x}",
            Sha256::digest(json_codec::stringify_js(&raw).unwrap().as_bytes())
        )
    );
    assert!(saved["entries"][0].get("npm").is_none());
    assert!(saved["entries"][0].get("api").is_none());
    assert!(catalog.search(&"🦊".repeat(151)).is_err());
    assert!(fake.calls.lock().unwrap().is_empty());
    let mut models = Map::new();
    for i in 0..90 {
        models.insert(i.to_string(), json!({}));
    }
    catalog.import(&json!({"p":{"models":models}})).unwrap();
    let found = catalog.search("").unwrap();
    assert_eq!(found["count"], 90);
    assert_eq!(found["models"].as_array().unwrap().len(), 80);
}
#[test]
fn model_budget_rejects_even_invalid_entries_after_thirty_thousand_valid_rows() {
    let mut models = Map::new();
    for i in 0..30000 {
        models.insert(format!("m{i}"), json!({}));
    }
    assert_eq!(
        parse_catalog(&json!({"p":{"models":models.clone()}}))
            .unwrap()
            .len(),
        30000
    );
    models.insert("invalid".into(), Value::Null);
    assert_eq!(
        parse_catalog(&json!({"p":{"models":models}}))
            .unwrap_err()
            .status,
        413
    );
}
#[tokio::test]
async fn refresh_uses_fixed_network_destination_and_respects_offline_policy() {
    let (catalog, _, fake, network) = fixture(false);
    assert_eq!(
        catalog.refresh(&RequestCancellation::new()).await.unwrap()["count"],
        1
    );
    assert_eq!(fake.calls.lock().unwrap().len(), 1);
    network.update_policy(
        NetworkPolicy::from_value(
            &json!({"schema":1,"revision":1,"mode":"offline","internetTools":true}),
        )
        .unwrap(),
    );
    assert!(
        catalog
            .refresh(&RequestCancellation::new())
            .await
            .unwrap_err()
            .blocked
    );
    assert_eq!(fake.calls.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn cancelled_refresh_does_not_replace_catalog_or_write_guessed_data() {
    let (catalog, state, fake, _) = fixture(true);
    catalog
        .import(&json!({"old":{"models":{"saved":{}}}}))
        .unwrap();
    let before = state.0.lock().unwrap().clone();
    let cancel = RequestCancellation::new();
    let c = cancel.clone();
    let task = tokio::spawn(async move { catalog.refresh(&c).await });
    while fake.calls.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    assert!(task.await.unwrap().is_err());
    assert_eq!(*state.0.lock().unwrap(), before);
}

#[tokio::test]
async fn closed_or_revoked_refresh_drains_without_replacing_saved_metadata() {
    for close in [true, false] {
        let (catalog, state, fake, network) = fixture(true);
        catalog.import(&json!({"old":{"models":{"saved":{}}}})).unwrap();
        let before = state.0.lock().unwrap().clone();
        let refresh = catalog.clone();
        let task = tokio::spawn(async move {refresh.refresh(&RequestCancellation::new()).await});
        while fake.calls.lock().unwrap().is_empty() {tokio::task::yield_now().await;}
        if close {catalog.close();} else {
            network.update_policy(NetworkPolicy::from_value(&json!({"schema":1,"revision":1,"mode":"offline","internetTools":true})).unwrap());
        }
        assert!(tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap().is_err());
        assert_eq!(*state.0.lock().unwrap(), before);
    }
}
