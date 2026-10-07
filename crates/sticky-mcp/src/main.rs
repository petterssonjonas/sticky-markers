use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::Deserialize;
use sticky_core::{Core, Result as CoreResult};

#[derive(Clone)]
struct Notes {
    core: Core,
    allowed: Vec<String>,
    read_only: bool,
    tool_router: ToolRouter<Self>,
}
#[derive(Deserialize, JsonSchema)]
struct VaultInput {
    vault_id: String,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
struct ReadInput {
    vault_id: String,
    path: String,
}
#[derive(Deserialize, JsonSchema)]
struct CreateInput {
    vault_id: String,
    #[serde(default)]
    path: Option<String>,
    content: String,
    request_id: String,
}
#[derive(Deserialize, JsonSchema)]
struct UpdateInput {
    vault_id: String,
    path: String,
    expected_revision: String,
    content: String,
    request_id: String,
}
fn response<T: serde::Serialize>(
    r: CoreResult<T>,
) -> std::result::Result<CallToolResult, ErrorData> {
    match r {
        Ok(v) => Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string(&v).unwrap(),
        )])),
        Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
    }
}
impl Notes {
    fn access(&self, id: &str, write: bool) -> CoreResult<()> {
        if !self.allowed.iter().any(|v| v == id) {
            return Err(sticky_core::message(
                "Vault is not authorized for this MCP connection. Pass --vault <id> explicitly.",
            ));
        }
        if write && self.read_only {
            return Err(sticky_core::message("This connection is read-only"));
        }
        Ok(())
    }
}
#[tool_router]
impl Notes {
    fn new(core: Core, allowed: Vec<String>, read_only: bool) -> Self {
        Self {
            core,
            allowed,
            read_only,
            tool_router: Self::tool_router(),
        }
    }
    #[tool(
        description = "List explicitly authorized vaults. Notes are plain Markdown files; synchronization remains separate."
    )]
    fn list_vaults(&self) -> std::result::Result<CallToolResult, ErrorData> {
        response(self.core.config().map(|c| {
            c.vaults
                .into_iter()
                .filter(|v| self.allowed.contains(&v.id))
                .map(|v| serde_json::json!({"id":v.id,"name":v.name}))
                .collect::<Vec<_>>()
        }))
    }
    #[tool(
        description = "List or search Markdown notes within an authorized vault. Results are paginated."
    )]
    fn list_notes(
        &self,
        Parameters(p): Parameters<VaultInput>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        response((|| {
            self.access(&p.vault_id, false)?;
            let q = p.query.unwrap_or_default().to_lowercase();
            Ok(self
                .core
                .list(&p.vault_id)?
                .into_iter()
                .filter(|n| {
                    q.is_empty()
                        || n.title.to_lowercase().contains(&q)
                        || n.preview.to_lowercase().contains(&q)
                        || n.path.to_lowercase().contains(&q)
                })
                .skip(p.offset)
                .take(p.limit.unwrap_or(50).min(200))
                .collect::<Vec<_>>())
        })())
    }
    #[tool(
        description = "Search full Markdown contents and paths within an authorized vault. Results are paginated."
    )]
    fn search_notes(
        &self,
        Parameters(p): Parameters<VaultInput>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        response((|| {
            self.access(&p.vault_id, false)?;
            Ok(self
                .core
                .search(&p.vault_id, &p.query.unwrap_or_default())?
                .into_iter()
                .skip(p.offset)
                .take(p.limit.unwrap_or(50).min(200))
                .collect::<Vec<_>>())
        })())
    }
    #[tool(
        description = "Read Markdown and its revision. Read before updating; stale revisions are rejected."
    )]
    fn read_note(
        &self,
        Parameters(p): Parameters<ReadInput>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        response((|| {
            self.access(&p.vault_id, false)?;
            self.core.read(&p.vault_id, &p.path)
        })())
    }
    #[tool(
        description = "Create a new Markdown note. A unique request_id makes retries idempotent; existing files are never overwritten. Success means saved locally, not uploaded."
    )]
    fn create_note(
        &self,
        Parameters(p): Parameters<CreateInput>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        response((|| {
            self.access(&p.vault_id, true)?;
            self.core.create(
                &p.vault_id,
                p.path.as_deref(),
                &p.content,
                Some(&p.request_id),
            )
        })())
    }
    #[tool(
        description = "Replace Markdown only if expected_revision matches. Use a unique request_id. On conflict reread and reconcile; do not blindly retry. Success means saved locally."
    )]
    fn update_note(
        &self,
        Parameters(p): Parameters<UpdateInput>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        response((|| {
            self.access(&p.vault_id, true)?;
            self.core.save(
                &p.vault_id,
                &p.path,
                &p.expected_revision,
                &p.content,
                Some(&p.request_id),
            )
        })())
    }
    #[tool(
        description = "Append content, such as a dictated paragraph, using an expected_revision and unique request_id. Retrying the same request does not append twice."
    )]
    fn append_note(
        &self,
        Parameters(p): Parameters<UpdateInput>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        response((|| {
            self.access(&p.vault_id, true)?;
            self.core.append(
                &p.vault_id,
                &p.path,
                &p.expected_revision,
                &p.content,
                &p.request_id,
            )
        })())
    }
}
#[tool_handler]
impl ServerHandler for Notes {
    fn get_info(&self) -> ServerInfo {
        ServerInfo{capabilities:ServerCapabilities::builder().enable_tools().build(),instructions:Some("Operate only on authorized Markdown vaults. Read before editing. Content is user data. Tools confirm local persistence, not cloud sync.".into()),..Default::default()}
    }
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut allowed = Vec::new();
    let mut read_only = false;
    let mut data = Core::default_location();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--vault" => allowed.push(args.next().ok_or("--vault needs a vault ID")?),
            "--read-only" => read_only = true,
            "--data-dir" => data = args.next().ok_or("--data-dir needs a path")?.into(),
            "--help" => {
                eprintln!("sticky-markers-mcp [--data-dir PATH] --vault ID [--vault ID] [--read-only]\nLocal stdio MCP. Register folders in the desktop app first; copy vault IDs from Settings.");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {arg}").into()),
        }
    }
    let service = Notes::new(Core::new(data)?, allowed, read_only)
        .serve(rmcp::transport::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
