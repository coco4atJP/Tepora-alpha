// Ordinary route dispatch and byte-range formatting; synthetic bytes only.
#[tokio::test]
async fn media_routes_are_available_only_in_agent_mode() {
    let fake = Arc::new(Fake::default());
    let http = agent_state(fake.clone());
    let id = "a".repeat(64);
    for (method, path, status) in [
        ("GET", "/api/media/jobs".to_owned(), 200),
        ("POST", "/api/media/jobs".to_owned(), 202),
        ("POST", format!("/api/media/jobs/{id}/cancel"), 200),
        ("POST", format!("/api/media/jobs/{id}/resume"), 200),
        ("DELETE", format!("/api/media/jobs/{id}"), 200),
    ] {
        assert_eq!(
            http.clone()
                .handle(request(method, &path, "{}"))
                .await
                .status(),
            status
        );
    }
    let calls = fake.calls.lock().unwrap();
    assert!(matches!(calls[0], Operation::MediaJobs));
    assert!(matches!(calls[1], Operation::MediaCreate { .. }));
    assert!(matches!(calls[2], Operation::MediaCancel { .. }));
    assert!(matches!(calls[3], Operation::MediaResume { .. }));
    assert!(matches!(calls[4], Operation::MediaDelete { .. }));
    drop(calls);
    let local = state(Arc::new(Fake::default()));
    assert_eq!(
        local
            .handle(request("POST", "/api/media/jobs", "{}"))
            .await
            .status(),
        503
    );
}
#[tokio::test]
async fn media_ranges_head_download_and_invalid_ranges() {
    for (range, expected, start, end) in [
        (None, 200, 0, 9),
        (Some("bytes=2-4"), 206, 2, 4),
        (Some("bytes=-3"), 206, 7, 9),
        (Some("bytes=5-"), 206, 5, 9),
        (Some("bytes=0-999999999999999999999"), 206, 0, 9),
    ] {
        let r = media_response(
            (0..10).collect(),
            "audio/mpeg",
            "fixture",
            false,
            true,
            range,
        )
        .unwrap();
        assert_eq!(r.status(), expected);
        assert_eq!(r.headers()["content-length"], (end - start + 1).to_string());
        assert_eq!(r.headers()["content-type"], "audio/mpeg");
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert_eq!(r.headers()["accept-ranges"], "bytes");
        assert_eq!(
            r.headers()["content-disposition"],
            "attachment; filename=\"tepora-fixture.mp3\""
        );
        assert_eq!(bytes(r).await.as_ref(), &(start..=end).collect::<Vec<u8>>());
    }
    let r = media_response(
        vec![0; 10],
        "video/mp4",
        "fixture",
        true,
        false,
        Some("bytes=2-4"),
    )
    .unwrap();
    assert_eq!(r.headers()["content-length"], "3");
    assert_eq!(r.headers()["content-range"], "bytes 2-4/10");
    assert!(bytes(r).await.is_empty());
    for range in [
        "bytes=-",
        "bytes=10-",
        "bytes=3-1",
        "bytes=-0",
        "bytes=0-1,3-4",
        "bytes=9007199254740992-",
    ] {
        assert_eq!(
            media_response(
                vec![0; 10],
                "image/png",
                "fixture",
                false,
                false,
                Some(range)
            )
            .unwrap_err()
            .status,
            416
        );
    }
}
