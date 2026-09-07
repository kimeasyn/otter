use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use otter_core::db::Db;
use otterd::{router, AppState};
use tower::ServiceExt;

#[tokio::test]
async fn local_api_requires_token_and_rejects_cross_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("test.db")).await.unwrap();
    let app = router(AppState::new(db, "test-token".into()), tmp.path().into());
    for (host, token, origin, expected) in [
        ("localhost:4317", "", None, StatusCode::UNAUTHORIZED),
        (
            "localhost:4317",
            "Bearer wrong",
            None,
            StatusCode::UNAUTHORIZED,
        ),
        (
            "evil.example:4317",
            "Bearer test-token",
            None,
            StatusCode::FORBIDDEN,
        ),
        (
            "127.0.0.1:4317",
            "Bearer test-token",
            Some("https://evil.example"),
            StatusCode::FORBIDDEN,
        ),
        (
            "127.0.0.1:4317",
            "Bearer test-token",
            Some("http://127.0.0.1:4317"),
            StatusCode::OK,
        ),
    ] {
        let mut req = Request::builder()
            .uri("/api/health")
            .header("host", host)
            .header("authorization", token);
        if let Some(origin) = origin {
            req = req.header("origin", origin);
        }
        let res = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), expected);
    }
}
