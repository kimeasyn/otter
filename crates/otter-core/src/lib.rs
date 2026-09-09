pub mod db;
pub mod execution;
pub mod git;
pub mod ingestion;
pub mod providers;
pub mod session_titles;
pub mod work;

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
