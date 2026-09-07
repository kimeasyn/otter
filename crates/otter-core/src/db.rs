use anyhow::Result;
use serde_json::{Map, Value};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Column, Row, SqlitePool, TypeInfo, ValueRef,
};
use std::{path::Path, time::Duration};

#[derive(Clone)]
pub struct Db(pub SqlitePool);

impl Db {
    pub async fn open(path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(Self(pool))
    }

    pub async fn rows(&self, sql: &str, args: Vec<Value>) -> Result<Vec<Value>> {
        let mut q = sqlx::query(sql);
        for value in args {
            q = match value {
                Value::Null => q.bind(None::<String>),
                Value::Bool(v) => q.bind(v),
                Value::Number(v) => q.bind(v.as_i64().unwrap_or_default()),
                Value::String(v) => q.bind(v),
                v => q.bind(v.to_string()),
            };
        }
        let mut output = Vec::new();
        for row in q.fetch_all(&self.0).await? {
            let mut object = Map::new();
            for col in row.columns() {
                let raw = row.try_get_raw(col.ordinal())?;
                let v = if raw.is_null() {
                    Value::Null
                } else {
                    match raw.type_info().name() {
                        "INTEGER" => Value::from(row.try_get::<i64, _>(col.ordinal())?),
                        "REAL" => Value::from(row.try_get::<f64, _>(col.ordinal())?),
                        _ => {
                            let text: String = row.try_get(col.ordinal())?;
                            if col.name().ends_with("_json") {
                                serde_json::from_str(&text).unwrap_or(Value::String(text))
                            } else {
                                Value::String(text)
                            }
                        }
                    }
                };
                object.insert(col.name().to_owned(), v);
            }
            output.push(Value::Object(object));
        }
        Ok(output)
    }

    pub async fn one(&self, sql: &str, args: Vec<Value>) -> Result<Value> {
        self.rows(sql, args)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("Record not found"))
    }

    pub async fn execute(&self, sql: &str, args: Vec<Value>) -> Result<()> {
        let mut q = sqlx::query(sql);
        for v in args {
            q = match v {
                Value::Null => q.bind(None::<String>),
                Value::Number(n) => q.bind(n.as_i64().unwrap_or_default()),
                Value::Bool(b) => q.bind(b),
                Value::String(s) => q.bind(s),
                other => q.bind(other.to_string()),
            };
        }
        q.execute(&self.0).await?;
        Ok(())
    }

    pub async fn reconcile(&self) -> Result<()> {
        // This daemon exclusively owns its database. Processes cannot be reattached
        // after a restart, and persisted PIDs must never be used to kill new processes.
        self.execute("UPDATE agent_instances SET status='interrupted',pid=NULL,ended_at=?,error='Otter restarted; previous execution cannot be reattached' WHERE status IN ('running','starting','stopping')",vec![crate::now().into()]).await?;
        self.execute(
            "UPDATE processes SET status='interrupted',pid=NULL,ended_at=? WHERE status='running'",
            vec![crate::now().into()],
        )
        .await?;
        self.execute(
            "UPDATE provider_sessions SET status='interrupted' WHERE status='running'",
            vec![],
        )
        .await?;
        Ok(())
    }
}
